import * as vscode from 'vscode';
import { readCodeBuddyCredential, type CodeBuddyCredential } from './codebuddy-auth';

const API = 'https://copilot.tencent.com';
const DOMAIN = 'copilot.tencent.com';
const USER_AGENT = 'CodeBuddyIDE/1.106.1';
const CATALOG_TTL_MS = 5 * 60_000;

interface CodeBuddyModel extends vscode.LanguageModelChatInformation {
	readonly id: string;
}

interface OpenAiMessage {
	role: string;
	content?: string | Array<string | { type: 'image_url'; image_url: { url: string } }>;
	tool_call_id?: string;
	tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

interface PendingToolCall {
	id: string;
	name: string;
	arguments: string;
}

/**
 * 向 Copilot Chat 上报真实 token 用量。
 *
 * ⚠️ Copilot 的上下文占用指示器（「N/M 个令牌」）**只读 `usage.promptTokens`**：
 * 它的分子是 `promptTokens + completionTokens`（见 workbench 的 contextUsage 控件），
 * 而第三方 provider 无法通过 `provideTokenCount` 影响它。
 *
 * 上报通道是：`LanguageModelDataPart` + **MIME `'usage'`**，载荷为 OpenAI 形状的
 * usage JSON。Copilot Chat 会拦截这个 part 并填入原生指示器。
 * 缺少它时界面会恒显示 `0/窗口`。
 */
function reportUsage(
	usage: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown; prompt_tokens_details?: unknown },
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
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
	// 运行时探测：老版本 VS Code 没有该类。
	const ThinkingPart = (vscode as unknown as { LanguageModelThinkingPart?: new (value: string | string[], id?: string) => unknown }).LanguageModelThinkingPart;
	if (ThinkingPart === undefined) {
		return;
	}
	progress.report(new ThinkingPart(text) as unknown as vscode.LanguageModelResponsePart);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * 估算纯文本的 token 数（不引入 tokenizer，纯启发式）。
 *
 * ⚠️ 不能再用 `chars / 4` —— 那是英文经验值，对中文会**低估约 4 倍**
 * （UTF-16 下 1 个汉字算 1 个 `length`，却被当成 0.25 个 token）。
 * 这里按 CJK 与其余字符分别加权：
 *
 * - **CJK**（汉字/日文/韩文/全角标点）：约 **1.0 token/字**（主流 BPE 词表对
 *   单个汉字多为 1~1.5 token，取 1.0 偏保守，避免高估后误判超长）；
 * - **其余**（ASCII 等）：约 **1 token / 3.7 字符**（英文经验值 3.5~4）。
 *
 * 这是**有意为之的粗略估算**：Copilot 的上下文指示器读的是 usage（见 `reportUsage`），
 * 本函数只服务工具预算/溢出判断，无需精确。
 */
function estimateTextTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (const ch of text) {
		// CJK 统一表意文字、日文假名、韩文音节、CJK 标点/全角形式。
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

function textFrom(value: unknown): string {
	if (typeof value === 'string') {return value;}
	if (!Array.isArray(value)) {return '';}
	return value.map((part) => {
		if (!isRecord(part)) {return '';}
		if (part instanceof vscode.LanguageModelTextPart) {return part.value;}
		if (part instanceof vscode.LanguageModelDataPart && !part.mimeType.startsWith('image/')) {
			return new TextDecoder().decode(part.data);
		}
		return typeof part.value === 'string' ? part.value : '';
	}).join('');
}

export function messagesToOpenAi(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAiMessage[] {
	const output: OpenAiMessage[] = [{ role: 'system', content: 'You are an AI coding assistant. Follow the conversation instructions and use the provided tools when appropriate.' }];
	for (const message of messages) {
		const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
		const content: Array<string | { type: 'image_url'; image_url: { url: string } }> = [];
		const toolCalls: NonNullable<OpenAiMessage['tool_calls']> = [];
		const toolResults: OpenAiMessage[] = [];
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				content.push(part.value);
				continue;
			}
			if (part instanceof vscode.LanguageModelDataPart) {
				if (part.mimeType.startsWith('image/')) {
					const encoded = Buffer.from(part.data).toString('base64');
					content.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${encoded}` } });
				} else {
					content.push(new TextDecoder().decode(part.data));
				}
				continue;
			}
			if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: { name: part.name, arguments: JSON.stringify(part.input) },
				});
				continue;
			}
			if (part instanceof vscode.LanguageModelToolResultPart) {
				toolResults.push({ role: 'tool', tool_call_id: part.callId, content: textFrom(part.content) });
				continue;
			}
			if (isRecord(part) && typeof part.value === 'string') {content.push(part.value);}
		}
		if (content.length > 0 || toolCalls.length > 0) {
			const textOnly = content.every((part): part is string => typeof part === 'string');
			const mergedContent = textOnly ? content.join('') : content;
			const normalizedContent = role === 'assistant'
				? rewriteCodeBuddyFingerprint(typeof mergedContent === 'string' ? mergedContent : '')
				: mergedContent;
			output.push({
				role,
				content: normalizedContent,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
		}
		output.push(...toolResults);
	}
	return output;
}

export function parseCodeBuddyModels(payload: unknown): CodeBuddyModel[] {
	if (!isRecord(payload) || !isRecord(payload.data)) {return fallbackModels();}
	const data = payload.data;
	const metadata = new Map<string, Record<string, unknown>>();
	if (Array.isArray(data.models)) {
		for (const item of data.models) {
			if (isRecord(item) && typeof item.id === 'string') {metadata.set(item.id, item);}
		}
	}
	const ids: string[] = [];
	const seen = new Set<string>();
	if (Array.isArray(data.agents)) {
		for (const preferredName of ['cli', 'craft']) {
			for (const agent of data.agents) {
				if (!isRecord(agent) || agent.name !== preferredName || !Array.isArray(agent.models)) {continue;}
				for (const id of agent.models) {
					if (typeof id === 'string' && !seen.has(id)) {
						seen.add(id);
						ids.push(id);
					}
				}
			}
		}
	}
	for (const id of metadata.keys()) {
		if (!seen.has(id)) {ids.push(id);}
	}
	const features = data.productFeaturesConfig;
	if (isRecord(features) && isRecord(features.ModelTrialBanner) && Array.isArray(features.ModelTrialBanner.banners)) {
		for (const banner of features.ModelTrialBanner.banners) {
			if (!isRecord(banner) || typeof banner.targetModelId !== 'string' || seen.has(banner.targetModelId)) {continue;}
			ids.push(banner.targetModelId);
		}
	}
	const models = ids.flatMap((id) => {
		const meta = metadata.get(id);
		if (id === 'auto' || id === 'default' || (Array.isArray(meta?.tags) && meta.tags.includes('text-to-image'))) {return [];}
		const name = typeof meta?.name === 'string' ? meta.name : id;
		if (id.startsWith('nes-') || id.startsWith('completion-') || id.startsWith('codewise-')) {return [];}
		if (meta?.supportsExtra === true || (typeof meta?.maxOutputTokens === 'number' && meta.maxOutputTokens > 0 && meta.maxOutputTokens <= 256)) {return [];}
		const inputTokens = numeric(meta?.maxInputTokens, 128_000);
		const outputTokens = numeric(meta?.maxOutputTokens, 16_000);
		return [{
			id,
			name,
			family: id,
			version: '1',
			maxInputTokens: inputTokens,
			maxOutputTokens: outputTokens,
			detail: 'CodeBuddy',
			capabilities: { imageInput: meta?.supportsImages === true, toolCalling: true },
		} satisfies CodeBuddyModel];
	});
	return models.length > 0 ? models : fallbackModels();
}

export function mergeCodeBuddyModels(
	preferred: readonly CodeBuddyModel[],
	additional: readonly CodeBuddyModel[],
): CodeBuddyModel[] {
	const ids = new Set(preferred.map((model) => model.id));
	const merged = [...preferred];
	for (const model of additional) {
		if (ids.has(model.id)) {continue;}
		ids.add(model.id);
		merged.push(model);
	}
	return merged;
}

function numeric(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function fallbackModels(): CodeBuddyModel[] {
	return [
		{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', family: 'deepseek-v4-flash', version: '1', maxInputTokens: 1_000_000, maxOutputTokens: 50_000, detail: 'CodeBuddy', capabilities: { imageInput: true, toolCalling: true } },
		{ id: 'hy4-preview', name: 'Hy4 Preview', family: 'hy4-preview', version: '1', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, detail: 'CodeBuddy', capabilities: { imageInput: true, toolCalling: true } },
		{ id: 'glm-5.3', name: 'GLM-5.3', family: 'glm-5.3', version: '1', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, detail: 'CodeBuddy', capabilities: { imageInput: true, toolCalling: true } },
	];
}

function rewriteCodeBuddyFingerprint(text: string): string {
	return text.replace(/Main branch \(you will usually use this for PRs\)/gi, 'Main branch (PRs usually go here)');
}

function toolDefinitions(tools: readonly vscode.LanguageModelChatTool[] | undefined): unknown[] | undefined {
	if (!tools?.length) {return undefined;}
	return tools.map((tool) => ({
		type: 'function',
		function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
	}));
}

export class CodeBuddyChatProvider implements vscode.LanguageModelChatProvider<CodeBuddyModel>, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;
	private cachedModels: CodeBuddyModel[] = [];
	private catalogLoadedAt = 0;

	constructor(private readonly secrets: vscode.SecretStorage, private readonly secretKey: string) {}

	async provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		token: vscode.CancellationToken,
	): Promise<CodeBuddyModel[]> {
		if (options.silent && (await this.secrets.get(this.secretKey)) === undefined) {return [];}
		const credential = await readCodeBuddyCredential(this.secrets, this.secretKey, token);
		if (!credential) {return [];}
		if (Date.now() - this.catalogLoadedAt > CATALOG_TTL_MS || this.cachedModels.length === 0) {
			await this.loadModels(credential, token);
		}
		return this.cachedModels;
	}

	async provideLanguageModelChatResponse(
		model: CodeBuddyModel,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const credential = await readCodeBuddyCredential(this.secrets, this.secretKey, token);
		if (!credential) {throw new Error('请先运行“CodeBuddy: 登录 / 管理账号”');}
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			const body: Record<string, unknown> = {
				model: model.id,
				messages: messagesToOpenAi(messages),
				stream: true,
				// ⚠️ OpenAI 兼容端点在流式模式下**默认不下发 usage**，必须显式开启，
				// 否则 Copilot 的上下文占用指示器永远拿不到真实 token 数（恒 0）。
				stream_options: { include_usage: true },
				max_tokens: model.maxOutputTokens,
			};
			const tools = toolDefinitions(options.tools);
			if (tools) {
				body.tools = tools;
				if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {body.tool_choice = 'required';}
			}
			const response = await fetch(`${API}/v2/chat/completions`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${credential.access_token}`,
					Accept: 'text/event-stream',
					'Content-Type': 'application/json',
					'X-Domain': DOMAIN,
					'X-Product-Code': 'codebuddy',
					'X-Agent-Purpose': 'conversation',
					'X-IDE-Name': 'CodeBuddy',
					'X-IDE-Type': 'CodeBuddy',
					'X-IDE-Version': '1.106.1',
					'X-Product': 'CodeBuddy',
					'User-Agent': USER_AGENT,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!response.ok) {
				const detail = await response.text();
				throw new Error(`CodeBuddy HTTP ${response.status}: ${detail.slice(0, 1000)}`);
			}
			if (!response.body) {throw new Error('CodeBuddy 返回了空响应流');}
			await consumeSse(response.body, progress, token);
		} finally {
			cancellation.dispose();
		}
	}

	provideTokenCount(_model: CodeBuddyModel, text: string | vscode.LanguageModelChatRequestMessage): Thenable<number> {
		if (typeof text === 'string') {
			return Promise.resolve(estimateTextTokens(text));
		}
		// 消息按 part 逐项累加，并计入每条消息的固定开销：
		// 逐项而非「拼成一坨再算」，是为了让工具调用/工具结果的 JSON 也按真实形态参与估算，
		// 并顺带吃掉 base 开销（老实现完全忽略这些）。
		let total = BASE_TOKENS_PER_MESSAGE + BASE_TOKENS_PER_NAME;
		for (const part of text.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				total += estimateTextTokens(part.value);
			} else if (part instanceof vscode.LanguageModelDataPart) {
				if (part.mimeType.startsWith('image/')) {
					// 图片按 base64 长度粗略折算（无解码、无尺寸探测）。
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

	/** 估算一次请求里工具定义的 token 开销（Copilot 会分别询问，这里给出一致口径）。 */
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

	async refreshModels(): Promise<void> {
		this.cachedModels = [];
		this.catalogLoadedAt = 0;
		this.changeEmitter.fire();
	}

	dispose(): void {
		this.changeEmitter.dispose();
	}

	private async loadModels(credential: CodeBuddyCredential, token: vscode.CancellationToken): Promise<void> {
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			const headers = {
				Authorization: `Bearer ${credential.access_token}`,
				'X-Domain': DOMAIN,
				'X-Product': 'SaaS',
				'X-Product-Code': 'codebuddy',
				'User-Agent': USER_AGENT,
			};
			const [scoped, config] = await Promise.all([
				fetch(`${API}/console/enterprises/personal/models`, { headers, signal: controller.signal }).catch(() => undefined),
				fetch(`${API}/v3/config`, { headers, signal: controller.signal }).catch(() => undefined),
			]);
			if (scoped?.status === 401 || scoped?.status === 403 || config?.status === 401 || config?.status === 403) {
				throw new Error('CodeBuddy 登录凭据已过期，请重新登录');
			}
			const scopedModels = scoped?.ok ? parseCodeBuddyModels(await scoped.json()) : [];
			const configModels = config?.ok ? parseCodeBuddyModels(await config.json()) : [];
			this.cachedModels = mergeCodeBuddyModels(
				scopedModels.length > 0 ? scopedModels : configModels,
				scopedModels.length > 0 ? configModels : [],
			);
		} catch (error) {
			if (token.isCancellationRequested) {throw error;}
		} finally {
			cancellation.dispose();
			this.catalogLoadedAt = Date.now();
		}
		if (this.cachedModels.length === 0) {this.cachedModels = fallbackModels();}
	}
}

export async function consumeSse(
	body: ReadableStream<Uint8Array>,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	token: vscode.CancellationToken,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	const toolCalls = new Map<number, PendingToolCall>();
	const emitLine = (line: string): void => {
		if (!line.startsWith('data:')) {return;}
		const payload = line.slice(5).trim();
		if (payload === '' || payload === '[DONE]') {return;}
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			throw new Error('CodeBuddy 返回了无法解析的 SSE 数据');
		}
		if (!isRecord(parsed)) {return;}
		if (isRecord(parsed.error)) {
			throw new Error(typeof parsed.error.message === 'string' ? parsed.error.message : 'CodeBuddy 返回了模型错误');
		}
		// ⚠️ usage 帧可能**不带 `choices`**（OpenAI 约定的最后一帧只带 usage），
		// 必须在取 choices 之前处理，否则会被下面的分支当成未知帧丢弃。
		if (isRecord(parsed.usage)) {
			reportUsage(parsed.usage, progress);
		}
		const choices = parsed.choices;
		if (!Array.isArray(choices)) {
			const message = typeof parsed.message === 'string'
				? parsed.message
				: typeof parsed.msg === 'string' ? parsed.msg : undefined;
			if (parsed.code !== undefined || message !== undefined) {
				throw new Error(message ?? `CodeBuddy 返回业务错误码 ${String(parsed.code)}`);
			}
			return;
		}
		for (const choice of choices) {
			if (!isRecord(choice) || !isRecord(choice.delta)) {continue;}
			const delta = choice.delta;
			// ⚠️ 思维链：上游把推理放在 `reasoning_content`（实测确认），与 `content` **并列**。
			// 老实现只读 `content`，导致思考过程被整个丢弃（用户表现为「不显示思维链」）。
			reportThinking(delta.reasoning_content, progress);
			if (typeof delta.content === 'string' && delta.content.length > 0) {
				progress.report(new vscode.LanguageModelTextPart(delta.content));
			}
			if (Array.isArray(delta.tool_calls)) {
				for (const value of delta.tool_calls) {
					if (!isRecord(value) || typeof value.index !== 'number') {continue;}
					const current = toolCalls.get(value.index) ?? { id: '', name: '', arguments: '' };
					if (typeof value.id === 'string') {current.id += value.id;}
					if (isRecord(value.function)) {
						if (typeof value.function.name === 'string') {current.name += value.function.name;}
						if (typeof value.function.arguments === 'string') {current.arguments += value.function.arguments;}
					}
					toolCalls.set(value.index, current);
				}
			}
		}
	};
	try {
		while (true) {
			if (token.isCancellationRequested) {
				await reader.cancel();
				throw new Error('请求已取消');
			}
			const { done, value } = await reader.read();
			if (done) {break;}
			buffer += decoder.decode(value, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, '');
				buffer = buffer.slice(newline + 1);
				emitLine(line);
			}
		}
		buffer += decoder.decode();
		if (buffer.trim()) {emitLine(buffer.trim());}
	} finally {
		reader.releaseLock();
	}
	for (const call of toolCalls.values()) {
		let input: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(call.arguments || '{}');
			if (!isRecord(parsed)) {throw new Error('工具参数必须是 JSON 对象');}
			input = parsed;
		} catch {
				throw new Error(`CodeBuddy 返回了无效的工具参数：${call.name}`);
		}
			if (!call.id || !call.name) {throw new Error('CodeBuddy 返回了不完整的工具调用');}
		progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
	}
}