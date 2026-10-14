// Qoder（中国版）的 VS Code 语言模型 Chat Provider。
//
// 把 Qoder CN 的加密推理链路（`agent_chat_generation`）接入 VS Code Copilot Chat。
//
// ## 关键协议点（踩过的坑，改动时务必保留）
//
// 1. **必须走加密端点**：公开的 OpenAI 兼容端点不认目录 key（`qfmodel` 等），
//    且 CN 的公开端点实测 503。请求体由 `qoder-cn-wasm.ts` 加密。
// 2. **`Authorization` 头由 WASM 生成**（`Bearer COSY.<载荷>.<签名>`），
//    **原样透传**，不能自己用 `Bearer <token>` 覆盖 —— 否则 `403 Signature invalid`。
// 3. **`uid` 必需**：缺它时 WASM 产出签名无效的请求。
// 4. **`business` 必填**：缺它服务端把请求路由到错误节点（`Execution failed`）。
// 5. **响应是带信封的 SSE**：每帧 `{headers, body:"<inner JSON>", statusCode...}`，
//    内层 `body` **未加密**，剥信封即得标准 OpenAI chunk。

import * as vscode from 'vscode';
import {
	type QoderCnFallbackModel,
	QODER_CN_FALLBACK_MODELS,
	qoderCnDisplayName,
} from './qoder-cn-models';
import {
	QODER_CN,
	qoderBearerToken,
	type QoderCredential,
} from './qoder-cn';
import {
	QoderEncryptedInfer,
	describeWasmFailure,
	type QoderInferMessage,
	type QoderInferRequest,
	type QoderInferTool,
	type QoderInferToolCall,
} from './qoder-cn-wasm';
import { ensureQoderCnUid, resolveQoderCnCredential } from './qoder-cn-auth';

interface QoderCnModel extends vscode.LanguageModelChatInformation {
	readonly id: string;
}

interface PendingToolCall {
	id: string;
	name: string;
	arguments: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * 转发模型思维链（`delta.reasoning_content`）到 Copilot 的「思考过程」块。
 *
 * ⚠️ `LanguageModelThinkingPart` 属 **proposed API**（类型见
 * `src/vscode.proposed.languageModelThinkingPart.d.ts`）。运行时若不支持则**静默跳过** ——
 * 思考链是增强功能，绝不能因为它导致整轮请求失败。
 */
function reportThinking(
	text: unknown,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	if (typeof text !== 'string' || text.length === 0) {
		return;
	}
	const ThinkingPart = (vscode as unknown as { LanguageModelThinkingPart?: new (value: string | string[], id?: string) => unknown }).LanguageModelThinkingPart;
	if (ThinkingPart === undefined) {
		return;
	}
	progress.report(new ThinkingPart(text) as unknown as vscode.LanguageModelResponsePart);
}

/**
 * 估算纯文本的 token 数（不引入 tokenizer，纯启发式）。
 *
 * ⚠️ 不能再用 `chars / 4` —— 那是英文经验值，对中文会**低估约 4 倍**。
 * 这里按 CJK 与其余字符分别加权：CJK 约 1.0 token/字，其余约 1 token / 3.7 字符。
 *
 * 这是**有意为之的粗略估算**：Copilot 的上下文指示器读的是 usage（见 `reportUsage`），
 * 本函数只服务工具预算/溢出判断，无需精确。
 */
function estimateTextTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (
			(code >= 0x3040 && code <= 0x30ff)   // 日文假名
			|| (code >= 0x3400 && code <= 0x4dbf) // CJK 扩展 A
			|| (code >= 0x4e00 && code <= 0x9fff) // CJK 基本区
			|| (code >= 0xac00 && code <= 0xd7af) // 韩文音节
			|| (code >= 0xf900 && code <= 0xfaff) // CJK 兼容表意文字
			|| (code >= 0xff00 && code <= 0xffef) // 全角/半角形式
		) {
			cjk += 1;
		} else {
			other += 1;
		}
	}
	return Math.ceil(cjk + other / 3.7);
}

/** 消息级固定开销：每条消息的角色/分隔符，加名字位（对齐 OpenAI 的经验值）。 */
const BASE_TOKENS_PER_MESSAGE = 3;
const BASE_TOKENS_PER_NAME = 1;
/** 工具集固定开销：一次请求带工具定义时的固定成本 + 每个工具的成本。 */
const BASE_TOKENS_PER_TOOL_SET = 16;
const BASE_TOKENS_PER_TOOL = 8;

/** 从内容块里取纯文本。 */
function textFrom(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (!Array.isArray(value)) {
		return '';
	}
	return value.map((part) => {
		if (!isRecord(part)) {
			return '';
		}
		if (part instanceof vscode.LanguageModelTextPart) {
			return part.value;
		}
		if (part instanceof vscode.LanguageModelDataPart && !part.mimeType.startsWith('image/')) {
			return new TextDecoder().decode(part.data);
		}
		return typeof part.value === 'string' ? part.value : '';
	}).join('');
}

/**
 * 把 VS Code 消息转成加密端点的 `messages[]`。
 *
 * ⚠️ **必须保留 assistant 的 `tool_calls` 与 `tool` 的 `tool_call_id`**：
 * 只发工具结果而不发对应的 assistant 调用，会让模型看不到自己调用过什么 ——
 * 表现为反复重调同一工具或凭空编造结果。
 *
 * ⚠️ **带图消息的 content 是多模态数组**，不能压成纯文本（否则图片丢失）。
 */
export function messagesToQoder(messages: readonly vscode.LanguageModelChatRequestMessage[]): QoderInferMessage[] {
	const output: QoderInferMessage[] = [];
	for (const message of messages) {
		const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
		const parts: Array<Record<string, unknown>> = [];
		const toolCalls: QoderInferToolCall[] = [];
		const toolResults: QoderInferMessage[] = [];
		let index = 0;
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				if (part.value.length > 0) {
					parts.push({ type: 'text', text: part.value });
				}
				continue;
			}
			if (part instanceof vscode.LanguageModelDataPart) {
				if (part.mimeType.startsWith('image/')) {
					const encoded = Buffer.from(part.data).toString('base64');
					parts.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${encoded}` } });
				} else {
					parts.push({ type: 'text', text: new TextDecoder().decode(part.data) });
				}
				continue;
			}
			if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId,
					type: 'function',
					index,
					function: { name: part.name, arguments: JSON.stringify(part.input) },
				});
				index += 1;
				continue;
			}
			if (part instanceof vscode.LanguageModelToolResultPart) {
				toolResults.push({ role: 'tool', content: textFrom(part.content), tool_call_id: part.callId });
				continue;
			}
			if (isRecord(part) && typeof part.value === 'string' && part.value.length > 0) {
				parts.push({ type: 'text', text: part.value });
			}
		}

		const hasImage = parts.some((p) => p.type === 'image_url');
		const textOnly = parts.every((p) => p.type === 'text');
		const merged: string | Array<Record<string, unknown>> = textOnly
			? parts.map((p) => String(p.text)).join('')
			: parts;
		// 纯文本且无内容、也无工具调用时跳过（避免发出空的 assistant 条目）。
		const isEmpty = typeof merged === 'string' && merged.length === 0 && !hasImage;
		if (!isEmpty || toolCalls.length > 0) {
			output.push({
				role,
				content: merged,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
		}
		output.push(...toolResults);
	}
	return output;
}

/** 把 VS Code 工具定义转成加密端点顶层 `tools`。 */
export function qoderTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): QoderInferTool[] {
	if (!tools?.length) {
		return [];
	}
	return tools.map((tool) => ({
		type: 'function' as const,
		function: {
			name: tool.name,
			...(tool.description.length > 0 ? { description: tool.description } : {}),
			...(tool.inputSchema === undefined ? {} : { parameters: tool.inputSchema as Record<string, unknown> }),
		},
	}));
}

/** 从 wire 消息里取最后一条 user 消息的文本。 */
function lastUserText(messages: readonly QoderInferMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== 'user') {
			continue;
		}
		if (typeof message.content === 'string') {
			return message.content;
		}
		return message.content
			.filter((block) => block.type === 'text')
			.map((block) => String(block.text ?? ''))
			.join('');
	}
	return '';
}

/** 内层帧的结构分类。 */
type InnerKind = 'chunk' | 'error' | 'heartbeat';

/**
 * 按 **JSON 结构**给信封内层帧分类。
 *
 * ⚠️ 不能用字符串嗅探（`!inner.includes('"choices"')`）：`body: null` 经
 * `JSON.stringify` 变成 `'null'`，会被误判成业务错误；而错误文案里恰好含
 * `"choices"` 的帧会被当正常帧静默透传。
 */
function classifyInner(inner: string): InnerKind {
	const trimmed = inner.trim();
	if (trimmed.length === 0) {
		return 'heartbeat';
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return 'error';
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return 'heartbeat';
	}
	const obj = parsed as Record<string, unknown>;
	if (Array.isArray(obj.choices) || obj.usage !== undefined) {
		return 'chunk';
	}
	if (
		obj.code !== undefined
		|| obj.message !== undefined
		|| obj.error !== undefined
		|| obj.statusCodeValue !== undefined
		|| obj.type !== undefined
	) {
		return 'error';
	}
	return 'heartbeat';
}

/** 从信封 JSON 文本里取出内层 OpenAI 帧文本；不是信封时返回 null。 */
function innerTextOf(payload: string): string | null {
	let envelope: unknown;
	try {
		envelope = JSON.parse(payload);
	} catch {
		return null;
	}
	if (!isRecord(envelope) || envelope.body === undefined) {
		return null;
	}
	return typeof envelope.body === 'string' ? envelope.body : JSON.stringify(envelope.body);
}

/** 一次 SSE 消费的结果。 */
interface SseOutcome {
	toolCalls: PendingToolCall[];
}

/**
 * 向 Copilot Chat 上报真实 token 用量。
 *
 * ⚠️ Copilot 的上下文占用指示器（「N/M 个令牌」）**只读 `usage.promptTokens`**：
 * 它的分子是 `promptTokens + completionTokens`，而第三方 provider 无法通过
 * `provideTokenCount` 影响它。上报通道是 `LanguageModelDataPart` + **MIME `'usage'`**，
 * 载荷为 OpenAI 形状的 usage JSON；缺少它时界面恒显示 `0/窗口`。
 */
function reportUsage(
	usage: unknown,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	if (!isRecord(usage)) {
		return;
	}
	const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
	const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
	progress.report(
		new vscode.LanguageModelDataPart(
			new TextEncoder().encode(JSON.stringify({
				prompt_tokens: promptTokens,
				completion_tokens: completionTokens,
				total_tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : promptTokens + completionTokens,
				prompt_tokens_details: usage.prompt_tokens_details ?? { cached_tokens: 0 },
			})),
			'usage',
		),
	);
}

/**
 * 消费 Qoder 加密端点的信封 SSE，向 `progress` 报告文本与工具调用。
 *
 * 逐帧剥信封后按标准 OpenAI chunk 解析（内层未加密）。
 */
export async function consumeQoderSse(
	body: ReadableStream<Uint8Array>,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	token: vscode.CancellationToken,
): Promise<SseOutcome> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	const toolCalls = new Map<number, PendingToolCall>();

	const emitLine = (line: string): void => {
		if (!line.startsWith('data:')) {
			// 非 `data:` 行（`event:` / 注释 / 空行）忽略。
			return;
		}
		const payload = line.slice(5).trim();
		if (payload === '' || payload === '[DONE]') {
			return;
		}
		const inner = innerTextOf(payload);
		// 非信封帧：容错当作标准帧处理（服务端某天直接回标准帧时仍可用）。
		const frame = inner === null ? payload : inner;
		// ⚠️⚠️ **`[DONE]` 必须在这里再判一次**（真实缺陷，2026-10-13 实测）：
		// Qoder 的结束帧是**信封里包着 `"body":"[DONE]"`**：
		//   `{"headers":{…},"body":"[DONE]","statusCodeValue":200,"statusCode":"OK"}`
		// 上面那处的判据只作用于**剥信封之前**的 `payload`，剥出来之后
		// `frame === '[DONE]'` 就漏网了 —— 它会先被 `classifyInner` 归为 `'chunk'`
		// （`includes('[DONE]')`），随后 `JSON.parse('[DONE]')` **抛错**。
		// 症状极具误导性：**模型内容全部正常输出**，但最后稳定报
		// 「无法解析的 SSE 数据」并触发 Copilot 整轮重试（实测重试 3 次）。
		const trimmedFrame = frame.trim();
		if (trimmedFrame === '' || trimmedFrame === '[DONE]') {
			return;
		}
		const kind = classifyInner(trimmedFrame);
		if (kind === 'heartbeat') {
			return;
		}
		// ⚠️ 无法解析的帧**必须把原文带出来**：早期实现只抛一句
		// 「无法解析的 SSE 数据」，把「纯文本错误体」（如 Qoder 的
		// `[FAIL]node:... msg:...`）与真正的解析缺陷混成同一条无信息量的
		// 错误，用户/排障者看不到任何原因。这里截断原文（避免超长报文刷屏，
		// 但保留足够定位的前 2000 字符）。
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmedFrame);
		} catch {
			throw new Error(`Qoder 返回了无法解析的 SSE 数据：${frame.slice(0, 2000)}`);
		}
		if (!isRecord(parsed)) {
			return;
		}
		if (kind === 'error') {
			const message = typeof parsed.message === 'string'
				? parsed.message
				: isRecord(parsed.error) && typeof parsed.error.message === 'string'
					? parsed.error.message
					: undefined;
			// ⚠️ 同样带出原文：Qoder 的业务错误常把真实原因放在 `data` / 嵌套字段里，
			// 只抛 `code` 会丢掉可定位信息。
			throw new Error(message ?? `Qoder 返回业务错误：${frame.slice(0, 2000)}`);
		}
		// ⚠️ usage 帧可能**不带 `choices`**（OpenAI 约定的最后一帧只带 usage），
		// 必须在取 choices 之前处理，否则会被下面的空数组分支丢弃。
		reportUsage(parsed.usage, progress);
		const choices = parsed.choices;
		if (!Array.isArray(choices)) {
			return;
		}
		for (const choice of choices) {
			if (!isRecord(choice) || !isRecord(choice.delta)) {
				continue;
			}
			const delta = choice.delta;
			// ⚠️ 思维链：上游把推理放在 `reasoning_content`，与 `content` **并列**。
			// 老实现只读 `content`，导致思考过程被整个丢弃（用户表现为「不显示思维链」）。
			reportThinking(delta.reasoning_content, progress);
			if (typeof delta.content === 'string' && delta.content.length > 0) {
				progress.report(new vscode.LanguageModelTextPart(delta.content));
			}
			if (Array.isArray(delta.tool_calls)) {
				for (const value of delta.tool_calls) {
					if (!isRecord(value) || typeof value.index !== 'number') {
						continue;
					}
					const current = toolCalls.get(value.index) ?? { id: '', name: '', arguments: '' };
					if (typeof value.id === 'string') {
						current.id += value.id;
					}
					if (isRecord(value.function)) {
						if (typeof value.function.name === 'string') {
							current.name += value.function.name;
						}
						if (typeof value.function.arguments === 'string') {
							current.arguments += value.function.arguments;
						}
					}
					toolCalls.set(value.index, current);
				}
			}
		}
	};

	try {
		for (;;) {
			if (token.isCancellationRequested) {
				await reader.cancel();
				throw new Error('请求已取消');
			}
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, '');
				buffer = buffer.slice(newline + 1);
				emitLine(line);
			}
		}
		buffer += decoder.decode();
		if (buffer.trim()) {
			emitLine(buffer.trim());
		}
	} finally {
		reader.releaseLock();
	}
	return { toolCalls: [...toolCalls.values()] };
}

/** `QoderCnChatProvider` 的构造选项。 */
export interface QoderCnChatProviderOptions {
	/** 凭据解析（含静默续期）。 */
	resolveCredential: () => Promise<QoderCredential | undefined>;
	/** 补齐 `uid`（加密推理必需）。 */
	ensureUid?: (credential: QoderCredential) => Promise<QoderCredential>;
	/** 注入的 fetch（测试用）；默认为全局 fetch。 */
	fetcher?: typeof fetch;
}

/** Qoder（中国版）的 VS Code 语言模型 Chat Provider。 */
export class QoderCnChatProvider implements vscode.LanguageModelChatProvider<QoderCnModel>, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

	constructor(private readonly options: QoderCnChatProviderOptions) {}

	private get fetcher(): typeof fetch {
		return this.options.fetcher ?? fetch;
	}

	/** 完整模型目录（本地兜底表 + 展示名）。 */
	listModels(): QoderCnModel[] {
		const now = new Date();
		return QODER_CN_FALLBACK_MODELS.map((model) => this.toModel(model, now));
	}

	private toModel(model: QoderCnFallbackModel, now: Date): QoderCnModel {
		return {
			id: model.id,
			name: qoderCnDisplayName(model, now),
			family: model.id,
			version: '1',
			detail: QODER_CN.displayName,
			maxInputTokens: model.contextWindow,
			maxOutputTokens: 32_000,
			capabilities: {
				imageInput: model.supportsImage === true,
				toolCalling: true,
			},
		};
	}

	async provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<QoderCnModel[]> {
		if (options.silent) {
			// 静默探测：不触发续期/网络，只看凭据是否存在。
			const credential = await this.options.resolveCredential().catch(() => undefined);
			return credential === undefined ? [] : this.listModels();
		}
		return this.listModels();
	}

	async provideLanguageModelChatResponse(
		model: QoderCnModel,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		let credential = await this.options.resolveCredential();
		if (credential === undefined) {
			throw new Error('请先运行“Qoder CN: 登录 / 管理账号”');
		}
		// 补齐 uid（旧凭据可能没有它，缺则签名无效）。
		if (this.options.ensureUid !== undefined) {
			credential = await this.options.ensureUid(credential);
		}
		if (credential.uid === undefined || credential.uid.length === 0) {
			throw new Error('Qoder 凭据缺少 uid，加密推理无法签名（请重新登录该账号）');
		}

		const fallback = QODER_CN_FALLBACK_MODELS.find((m) => m.id === model.id);
		const history = messagesToQoder(messages);
		const request = await this.buildRequest(credential, fallback, history, model, qoderTools(options.tools));

		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			const response = await this.fetcher(request.url, {
				method: 'POST',
				headers: new Headers(request.headers),
				body: request.body,
				signal: controller.signal,
			});
			if (!response.ok) {
				const detail = await response.text().catch(() => '');
				throw new Error(`Qoder HTTP ${response.status}: ${detail.slice(0, 1000)}`);
			}
			if (!response.body) {
				throw new Error('Qoder 返回了空响应流');
			}
			const outcome = await consumeQoderSse(response.body, progress, token);
			for (const call of outcome.toolCalls) {
				let input: Record<string, unknown>;
				try {
					const parsed: unknown = JSON.parse(call.arguments || '{}');
					if (!isRecord(parsed)) {
						throw new Error('工具参数必须是 JSON 对象');
					}
					input = parsed;
				} catch {
					throw new Error(`Qoder 返回了无效的工具参数：${call.name}`);
				}
				if (!call.id || !call.name) {
					throw new Error('Qoder 返回了不完整的工具调用');
				}
				progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
			}
		} finally {
			cancellation.dispose();
		}
	}

	/** 构造一次加密推理请求（含 WASM 上下文释放）。 */
	private async buildRequest(
		credential: QoderCredential,
		fallback: QoderCnFallbackModel | undefined,
		history: readonly QoderInferMessage[],
		model: QoderCnModel,
		tools: QoderInferTool[],
	): Promise<QoderInferRequest> {
		let client: QoderEncryptedInfer | undefined;
		try {
			client = await QoderEncryptedInfer.create({
				user: {
					uid: credential.uid!,
					securityOauthToken: qoderBearerToken(credential),
				},
				machineId: credential.machine_id,
				metadata: { ...QODER_CN.clientMetadata },
				host: QODER_CN.encryptedInferBase,
			});
			return client.prepareInfer({
				modelKey: model.id,
				userText: lastUserText(history),
				isReasoning: fallback?.supportsThinking ?? false,
				history,
				tools,
				...(Number.isFinite(model.maxOutputTokens) && model.maxOutputTokens > 0
					? { maxTokens: model.maxOutputTokens }
					: {}),
				...(fallback?.supportsImage !== undefined ? { isVl: fallback.supportsImage } : {}),
				...(fallback?.name !== undefined ? { displayName: fallback.name } : {}),
				...(fallback?.contextWindow !== undefined ? { maxInputTokens: fallback.contextWindow } : {}),
				sessionType: QODER_CN.sessionType,
				// `business` 必填，否则服务端把请求路由到故障节点。
				business: { type: 'agent' },
			});
		} catch (error) {
			throw describeWasmFailure(error);
		} finally {
			// 释放失败绝不能顶替 `try` 块里的原始错误（清理动作不该改变本次请求的结论）。
			try {
				client?.dispose();
			} catch {
				// 见上：清理失败不上抛、不改写本次请求的结论。
			}
		}
	}

	provideTokenCount(_model: QoderCnModel, text: string | vscode.LanguageModelChatRequestMessage): Thenable<number> {
		if (typeof text === 'string') {
			return Promise.resolve(estimateTextTokens(text));
		}
		// 消息按 part 逐项累加，并计入每条消息的固定开销（老实现两者都缺失）。
		let total = BASE_TOKENS_PER_MESSAGE + BASE_TOKENS_PER_NAME;
		for (const part of text.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				total += estimateTextTokens(part.value);
			} else if (part instanceof vscode.LanguageModelDataPart) {
				if (part.mimeType.startsWith('image/')) {
					total += Math.ceil(part.data.byteLength / 100);
				} else {
					total += estimateTextTokens(new TextDecoder().decode(part.data));
				}
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				total += BASE_TOKENS_PER_NAME + estimateTextTokens(JSON.stringify(part.input));
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				total += estimateTextTokens(textFrom(part.content));
			} else if (isRecord(part) && typeof part.value === 'string') {
				total += estimateTextTokens(part.value);
			}
		}
		return Promise.resolve(total);
	}

	/** 估算一次请求里工具定义的 token 开销（与 CodeBuddy 保持同一口径）。 */
	estimateToolTokens(tools: readonly vscode.LanguageModelChatTool[] | undefined): number {
		if (!tools?.length) {
			return 0;
		}
		let total = BASE_TOKENS_PER_TOOL_SET;
		for (const tool of tools) {
			total += BASE_TOKENS_PER_TOOL + estimateTextTokens(JSON.stringify(tool));
		}
		return total;
	}

	refreshModels(): void {
		this.changeEmitter.fire();
	}

	dispose(): void {
		this.changeEmitter.dispose();
	}
}

/** 便捷工厂：用 SecretStorage + 默认凭据键构造 provider。 */
export function createQoderCnProvider(
	secrets: vscode.SecretStorage,
	secretKey: string,
): QoderCnChatProvider {
	return new QoderCnChatProvider({
		resolveCredential: () => resolveQoderCnCredential(secrets, secretKey),
		ensureUid: (credential) => ensureQoderCnUid(secrets, secretKey, credential),
	});
}
