// OpenRouter 的 VS Code 语言模型 Chat Provider。
//
// 把 OpenRouter 的 **标准 OpenAI 兼容** 端点接入 VS Code Copilot Chat。
// 与另外三家最根本的差异：这里**不需要伪装成任何客户端** —— 一次 Bearer 认证即可。
//
// ## 关键协议点（改动时务必保留）
//
// 1. **流内错误必须抛**：响应头一旦提交，HTTP 就恒是 200，上游把失败放在
//    SSE 帧顶层的 `error` 里（`choices[0].finish_reason === 'error'`）。官方文档
//    明确「错误可能是流里的第一个也是唯一一个事件」⇒ 只看 HTTP 状态会把
//    「一个 token 都没出的失败」误判成「成功但没内容」。
// 2. **`: OPENROUTER PROCESSING` 心跳注释帧必须在 `JSON.parse` 之前跳过**。
// 3. **usage 帧是上游总是会发的**（在 `[DONE]` 之前），**不需要** `stream_options`
//    —— 这与 CodeBuddy 相反（那边必须显式 `include_usage`）。
// 4. **思考链字段是 `reasoning`**（`reasoning_content` 是它的别名），结构化版本
//    在 `reasoning_details[]`。
// 5. **供应商与模型是两级目录**：模型列表里没有供应商，必须逐模型查端点
//    （见 `openrouter.ts` 的文件头）。
//
// ## 为什么**刻意不下发** `max_tokens`
//
// 官方 provider-routing 文档：**只要请求带 `max_tokens`，OpenRouter 就只把请求
// 路由给「支持该长度」的端点**。而模型级 `top_provider.max_completion_tokens`
// 是**榜首那家**的上限 —— 实测 `deepseek/deepseek-v4.1-flash` 各家在
// 131072 ~ 943718 之间分布。于是：下发一个按榜首算出的 `max_tokens`，
// 会让用户明确锁定的、上限较小的那家在**路由阶段**就被排除 ⇒ 结合
// `allow_fallbacks: false`（用户选定的严格语义）直接变成**请求失败**。
// 不发 `max_tokens` 时 OpenRouter 交给上游自己的默认上限，行为更符合预期。

import * as vscode from 'vscode';
import {
	OPENROUTER_CHAT_URL,
	OPENROUTER_EFFORT_NAMES,
	OPENROUTER_MODELS_URL,
	isOpenRouterAuthStatus,
	openRouterDefaultEffort,
	openRouterEffortsOf,
	openRouterEndpointsUrl,
	openRouterHttpErrorText,
	openRouterProviderField,
	openRouterReasoningField,
	openRouterThinkingText,
	parseOpenRouterModels,
	parseOpenRouterProviders,
	selectOpenRouterModels,
	type OpenRouterProviderOption,
	type OpenRouterRemoteModel,
} from './openrouter';
import { readOpenRouterCredential, type OpenRouterCredential } from './openrouter-auth';
import { readPinnedProviders } from './openrouter-settings';

/**
 * OpenRouter 的 **vendor id**（必须与 `package.json` 的
 * `contributes.languageModelChatProviders[].vendor` 逐字一致）。
 *
 * ⚠️⚠️ **不能用 `openrouter`** —— 官方契约原话：vendor「**Must be globally unique**」
 * （`registerLanguageModelChatProvider` 的 `@param vendor`），而 **Copilot Chat 内置的
 * BYOK 已经占了 `openrouter` 这个名字**。
 *
 * 重名的症状是最难查的那种：我们的 `provideLanguageModelChatInformation` **照样被调用**
 * （所以日志看着一切正常、模型也返回了），但模型选择器里就是不出现我们的模型
 * —— 用户 2026-10-15 实测报障（日志显示 16 个模型已返回，列表里却看不到）。
 *
 * ⚠️ `openrouter-byok` 是**故意**与内置名区分开的（且官方 `package.json` 示例用的就是
 * 带连字符的 `my-provider`，故连字符合法）。改这个名字**不需要用户重填 key**
 * —— 凭据 key 是我们自己的命名空间，与 vendor 无关。
 */
export const OPENROUTER_VENDOR = 'openrouter-byok';

/** 目录缓存有效期（毫秒）。 */
const CATALOG_TTL_MS = 5 * 60_000;

/**
 * 消息级固定开销：每条消息的角色/分隔符，加名字位（对齐 OpenAI 的经验值）。
 */
const BASE_TOKENS_PER_MESSAGE = 3;
const BASE_TOKENS_PER_NAME = 1;
/** 工具集固定开销：一次请求带工具定义时的固定成本 + 每个工具的成本。 */
const BASE_TOKENS_PER_TOOL_SET = 16;
const BASE_TOKENS_PER_TOOL = 8;

/**
 * 注入的系统提示。
 *
 * ⚠️ 本版本的 VS Code API（`@types/vscode@1.140.0`）里
 * `LanguageModelChatMessageRole` **只有 User / Assistant 两个角色**（没有 System），
 * 且 `ProvideLanguageModelChatResponseOptions` 没有 `system` 字段
 * （见 AGENTS.md 的实测记录）—— 所以系统提示只能由插件自己作为首条消息注入。
 */
const SYSTEM_PROMPT = 'You are an AI coding assistant. Follow the conversation instructions and use the provided tools when appropriate.';

/** OpenRouter 消息（OpenAI 形状）。 */
export interface OpenRouterMessage {
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

/** 模型选择器里的一个模型。 */
export interface OpenRouterModel extends vscode.LanguageModelChatInformation {
	readonly id: string;
	/** 该模型可选的上游供应商（空 = 不声明该选项）。 */
	readonly providerOptions: readonly OpenRouterProviderOption[];
	/** 该模型声明的思考档位（弱 → 强；空 = 不声明该选项）。 */
	readonly efforts: readonly string[];
}

/** 目录缓存里的一条（模型 + 它的上游供应商）。 */
interface CatalogEntry {
	model: OpenRouterRemoteModel;
	providerOptions: readonly OpenRouterProviderOption[];
}

/** `OpenRouterChatProvider` 的构造选项（`fetch*` 注入以便测试）。 */
export interface OpenRouterChatProviderOptions {
	/** 凭据解析。 */
	resolveCredential: () => Promise<OpenRouterCredential | undefined>;
	/**
	 * 读用户为该模型绑定的上游供应商 slug（未绑/「自动」时返回 `undefined`）。
	 *
	 * ⚠️ 来源是 VS Code 设置而不是模型选择器 —— **为什么不能放进选择器**
	 * 的完整源码依据见 `openrouter-settings.ts` 的文件头。
	 */
	readPinnedProvider?: (modelId: string) => string | undefined;
	/** 拉取模型目录原始 JSON。 */
	fetchCatalog?: (credential: OpenRouterCredential, signal: AbortSignal) => Promise<unknown>;
	/** 拉取某模型的上游端点原始 JSON。 */
	fetchProviders?: (modelId: string, credential: OpenRouterCredential, signal: AbortSignal) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** 把任何抛出物转成可读文案。 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 转发模型思维链到 Copilot 的「思考过程」块。
 *
 * ⚠️ `LanguageModelThinkingPart` 属 **proposed API**（类型见
 * `src/vscode.proposed.languageModelThinkingPart.d.ts`）。运行时若不支持则
 * **静默跳过** —— 思考链是增强功能，绝不能因为它导致整轮请求失败。
 */
function reportThinking(
	text: unknown,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	if (typeof text !== 'string' || text.length === 0) {
		return;
	}
	const ThinkingPart = (vscode as unknown as {
		LanguageModelThinkingPart?: new (value: string | string[], id?: string) => unknown;
	}).LanguageModelThinkingPart;
	if (ThinkingPart === undefined) {
		return;
	}
	progress.report(new ThinkingPart(text) as unknown as vscode.LanguageModelResponsePart);
}

/**
 * 向 Copilot Chat 上报真实 token 用量。
 *
 * ⚠️ Copilot 的上下文占用指示器（「N/M 个令牌」）**只读 `usage.promptTokens`**，
 * 而第三方 provider 无法通过 `provideTokenCount` 影响它。上报通道是
 * `LanguageModelDataPart` + **MIME `'usage'`**，载荷为 OpenAI 形状的 usage JSON；
 * 缺少它时界面恒显示 `0/窗口`。
 */
function reportUsage(
	usage: Record<string, unknown>,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
	const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
	const promptDetails = isRecord(usage.prompt_tokens_details)
		? usage.prompt_tokens_details
		: { cached_tokens: 0 };
	progress.report(
		new vscode.LanguageModelDataPart(
			new TextEncoder().encode(JSON.stringify({
				prompt_tokens: promptTokens,
				completion_tokens: completionTokens,
				total_tokens: typeof usage.total_tokens === 'number'
					? usage.total_tokens
					: promptTokens + completionTokens,
				prompt_tokens_details: promptDetails,
			})),
			'usage',
		),
	);
}

/**
 * 估算纯文本的 token 数（不引入 tokenizer，纯启发式）。
 *
 * ⚠️ 不能再用 `chars / 4` —— 那是英文经验值，对中文会**低估约 4 倍**。
 * 这里按 CJK 与其余字符分别加权：CJK 约 1.0 token/字，其余约 1 token / 3.7 字符。
 */
function estimateTextTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (const ch of text) {
		const source = ch.codePointAt(0) ?? 0;
		if (
			(source >= 0x3040 && source <= 0x30ff)   // 日文假名
			|| (source >= 0x3400 && source <= 0x4dbf) // CJK 扩展 A
			|| (source >= 0x4e00 && source <= 0x9fff) // CJK 基本区
			|| (source >= 0xac00 && source <= 0xd7af) // 韩文音节
			|| (source >= 0xf900 && source <= 0xfaff) // CJK 兼容表意文字
			|| (source >= 0xff00 && source <= 0xffef) // 全角/半角形式
		) {
			cjk += 1;
		} else {
			other += 1;
		}
	}
	return Math.ceil(cjk + other / 3.7);
}

function textFrom(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (!Array.isArray(value)) {
		return '';
	}
	return value.map((part) => {
		if (part instanceof vscode.LanguageModelTextPart) {
			return part.value;
		}
		if (part instanceof vscode.LanguageModelDataPart && !part.mimeType.startsWith('image/')) {
			return new TextDecoder().decode(part.data);
		}
		if (isRecord(part) && typeof part.value === 'string') {
			return part.value;
		}
		return '';
	}).join('');
}

/**
 * 把 VS Code 的消息转换为 OpenRouter（OpenAI 形状）的消息。
 *
 * ⚠️ 工具调用与工具结果**都必须下发**：只发工具结果会让模型「看不到自己调用过
 * 什么」，于是反复重调或凭空编造（与另外三家同一约定）。
 */
export function messagesToOpenRouter(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): OpenRouterMessage[] {
	const output: OpenRouterMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
	for (const message of messages) {
		const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
		const content: Array<string | { type: 'image_url'; image_url: { url: string } }> = [];
		const toolCalls: NonNullable<OpenRouterMessage['tool_calls']> = [];
		const toolResults: OpenRouterMessage[] = [];
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				content.push(part.value);
				continue;
			}
			if (part instanceof vscode.LanguageModelDataPart) {
				if (part.mimeType.startsWith('image/')) {
					// ⚠️ 图片必须走**多模态数组**（`image_url` + data URL）：
					// 压成纯文本会静默丢图。
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
			if (isRecord(part) && typeof part.value === 'string') {
				content.push(part.value);
			}
		}
		if (content.length > 0 || toolCalls.length > 0) {
			const textOnly = content.every((part): part is string => typeof part === 'string');
			output.push({
				role,
				content: textOnly ? content.join('') : content,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
		}
		output.push(...toolResults);
	}
	return output;
}

/** 工具定义（OpenAI 形状）。 */
export function openRouterTools(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
): unknown[] | undefined {
	if (!tools?.length) {
		return undefined;
	}
	return tools.map((tool) => ({
		type: 'function',
		function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
	}));
}

/** 请求体构造的输入。 */
export interface OpenRouterRequestBodyInput {
	readonly model: OpenRouterModel;
	readonly messages: readonly vscode.LanguageModelChatRequestMessage[];
	/** 模型选择器里的思考档位（可能来自缓存旧目录，必须再校验）。 */
	readonly effort: unknown;
	/** 用户设置里为该模型绑定的上游 supplier slug（`undefined` / `'auto'` = 不锁）。 */
	readonly pinnedSlug: string | undefined;
	readonly tools: readonly vscode.LanguageModelChatTool[] | undefined;
	readonly toolMode: vscode.LanguageModelChatToolMode;
}

/**
 * 构造发给 OpenRouter 的请求体（**纯函数**，便于单测）。
 *
 * ⚠️ **刻意不下发 `max_tokens`**（理由见文件头）：它会参与 OpenRouter 的路由过滤
 * （「只路由给支持该长度的端点」），而模型级 `top_provider.max_completion_tokens`
 * 是**榜首那家**的上限（实测同模型各家在 131072 ~ 943718 分布）⇒ 下发一个按榜首
 * 算出的上限，会把用户锁定的、上限较小的那家在**路由阶段**就排除掉，
 * 叠加 `allow_fallbacks: false` 直接变成请求失败。
 *
 * ⚠️ 两个「用户选择」都必须**再校验一次**（它们都可能来自缓存/手改）：
 * - 思考档位不在 `model.efforts` 里 ⇒ 当未选（发未知档位会被上游 400）；
 * - 上游 slug 不在 `model.providerOptions` 里 ⇒ 不锁定（否则会被上游 404）。
 */
export function openRouterRequestBody(input: OpenRouterRequestBodyInput): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: input.model.id,
		messages: messagesToOpenRouter(input.messages),
		stream: true,
	};
	const reasoning = openRouterReasoningField(input.effort, input.model.efforts);
	if (reasoning !== undefined) {
		body.reasoning = reasoning;
	}
	const pinned = openRouterProviderField(input.pinnedSlug, input.model.providerOptions);
	if (pinned !== undefined) {
		body.provider = pinned;
	}
	const tools = openRouterTools(input.tools);
	if (tools) {
		body.tools = tools;
		if (input.toolMode === vscode.LanguageModelChatToolMode.Required) {
			body.tool_choice = 'required';
		}
	}
	return body;
}

/** 从错误对象里取人类可读文案。 */
function errorTextOf(error: unknown): string {
	if (isRecord(error)) {
		if (typeof error.message === 'string' && error.message.length > 0) {
			return error.message;
		}
		if (typeof error.code === 'string' || typeof error.code === 'number') {
			return `错误码 ${String(error.code)}`;
		}
	}
	return '上游未提供原因';
}

/**
 * 消费 OpenRouter 的 SSE 流。
 *
 * ⚠️ 三条容易写错的：
 * 1. **注释帧**（`: OPENROUTER PROCESSING`，防连接超时用）必须先跳过，
 *    直接喂 `JSON.parse` 会抛错并**掀掉整个流循环**；
 * 2. **流内错误**必须抛（HTTP 已是 200，只有帧里的 `error` 说得清）；
 * 3. usage 帧是**总是会发**的（`[DONE]` 之前），且它**带 choices**
 *    （上游刻意偏离 OpenAI 规范：带一个 content 为空的 delta），
 *    所以不能靠「没有 choices 就是 usage 帧」来识别。
 */
export async function consumeOpenRouterSse(
	body: ReadableStream<Uint8Array>,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	token: vscode.CancellationToken,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	const toolCalls = new Map<number, PendingToolCall>();
	const emitLine = (line: string): void => {
		// SSE 注释（以 `:` 开头）—— 必须先于任何解析跳过。
		if (line.startsWith(':')) {
			return;
		}
		if (!line.startsWith('data:')) {
			return;
		}
		const payload = line.slice(5).trim();
		if (payload === '' || payload === '[DONE]') {
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			throw new Error(`OpenRouter 返回了无法解析的 SSE 数据：${payload.slice(0, 500)}`);
		}
		if (!isRecord(parsed)) {
			return;
		}
		// ⚠️ 流内错误：响应头已提交 ⇒ HTTP 恒 200，失败只在这条 `error` 帧里。
		if (parsed.error !== undefined && parsed.error !== null) {
			throw new Error(`OpenRouter 请求失败：${errorTextOf(parsed.error)}`);
		}
		if (isRecord(parsed.usage)) {
			reportUsage(parsed.usage, progress);
		}
		const choices = parsed.choices;
		if (!Array.isArray(choices)) {
			return;
		}
		for (const choice of choices) {
			if (!isRecord(choice) || !isRecord(choice.delta)) {
				continue;
			}
			const delta = choice.delta;
			reportThinking(openRouterThinkingText(delta), progress);
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
		while (true) {
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
	for (const call of toolCalls.values()) {
		if (!call.id || !call.name) {
			throw new Error('OpenRouter 返回了不完整的工具调用');
		}
		let input: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(call.arguments || '{}');
			if (!isRecord(parsed)) {
				throw new Error('工具参数必须是 JSON 对象');
			}
			input = parsed;
		} catch {
			throw new Error(`OpenRouter 返回了无效的工具参数：${call.name}`);
		}
		progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
	}
}

/** OpenRouter 的 VS Code 语言模型 Chat Provider。 */
export class OpenRouterChatProvider implements vscode.LanguageModelChatProvider<OpenRouterModel>, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

	private catalog: CatalogEntry[] | undefined;
	private catalogLoadedAt = 0;
	/**
	 * 正在进行的目录拉取（**in-flight 去重**）。
	 *
	 * ⚠️ 这不是优化而是**真缺陷的修法**：VS Code 会**并发**多次调用
	 * `provideLanguageModelChatInformation`（实测十几次），而那时
	 * `catalogLoadedAt` 还是旧值 ⇒ 每一路都会各自发一轮「1 次目录 + N 次上游查询」
	 * （本模型下 N=16）⇒ 一次打开选择器可能打十几个请求。
	 * 共享同一个 Promise 后，同批调用只会发一轮。
	 */
	private catalogLoad: Promise<void> | undefined;

	constructor(private readonly options: OpenRouterChatProviderOptions) {}

	private get fetchCatalog(): NonNullable<OpenRouterChatProviderOptions['fetchCatalog']> {
		return this.options.fetchCatalog ?? (async (credential, signal) => {
			const response = await fetch(OPENROUTER_MODELS_URL, {
				headers: { Authorization: `Bearer ${credential.api_key}` },
				signal,
			});
			if (!response.ok) {
				throw new Error(openRouterHttpErrorText(response.status, await response.text(), undefined));
			}
			return response.json();
		});
	}

	private get fetchProviders(): NonNullable<OpenRouterChatProviderOptions['fetchProviders']> {
		return this.options.fetchProviders ?? (async (modelId, credential, signal) => {
			const response = await fetch(openRouterEndpointsUrl(modelId), {
				headers: { Authorization: `Bearer ${credential.api_key}` },
				signal,
			});
			if (!response.ok) {
				throw new Error(openRouterHttpErrorText(response.status, await response.text(), undefined));
			}
			return response.json();
		});
	}

	/** 完整模型目录（`undefined` = 还没拉到过）。 */
	listModels(): OpenRouterModel[] {
		return (this.catalog ?? []).map((entry) => toChatModel(entry));
	}

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		token: vscode.CancellationToken,
	): Promise<OpenRouterModel[]> {
		// ⚠️ 这里**吞掉**凭据损坏/读取失败：把它当「未登录」处理。
		// 让选模型这条路径抛错会把 provider 打进错误态，而用户的补救动作
		// （重新设置 API Key）与「没登录」完全一样。
		const credential = await this.options.resolveCredential().catch(() => undefined);
		if (credential === undefined) {
			return [];
		}
		await this.ensureCatalog(credential, token);
		// ⚠️ `silent` 只表示「不要弹窗/不要触发登录」，**不表示**「不要网络」
		// —— 与另外三家同一口径（否则模型选择器里永远看不到新模型）。
		return this.listModels();
	}

	/**
	 * 确保目录可用：命中缓存则直接返回，否则共享/发起一次拉取。
	 *
	 * ⚠️ **共享同一个 Promise** 是关键：VS Code 会**高频并发**调用
	 * `provideLanguageModelChatInformation`（打开选择器、每个会话解析当前模型…），
	 * 而 `catalogLoadedAt` 是在拉取**完成之后**才写的 ⇒ 若各走各的，每一路都会
	 * 各自发一轮「1 次目录 + N 次逐模型上游查询」（本模型下 N=16）。
	 */
	private async ensureCatalog(credential: OpenRouterCredential, token: vscode.CancellationToken): Promise<void> {
		if (this.catalog !== undefined && Date.now() - this.catalogLoadedAt <= CATALOG_TTL_MS) {
			return;
		}
		if (this.catalogLoad === undefined) {
			// ⚠️ `finally` 里必须清掉：失败时也要允许下一次重试（否则一次瞬时故障
			// 会把目录永久锁死为「永不重试」）。
			this.catalogLoad = this.loadCatalog(credential, token).finally(() => {
				this.catalogLoad = undefined;
			});
		}
		await this.catalogLoad;
	}

	async provideLanguageModelChatResponse(
		model: OpenRouterModel,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const credential = await this.options.resolveCredential();
		if (credential === undefined) {
			throw new Error('请先运行“OpenRouter: 设置 API Key”');
		}
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			// 上游供应商：读**用户设置**里的绑定（不来自模型选择器，理由见 openrouter-settings.ts）。
			const pinnedSlug = this.options.readPinnedProvider?.(model.id);
			const body = openRouterRequestBody({
				model,
				messages,
				effort: options.modelConfiguration?.reasoningEffort,
				pinnedSlug,
				tools: options.tools,
				toolMode: options.toolMode,
			});
			const response = await fetch(OPENROUTER_CHAT_URL, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${credential.api_key}`,
					Accept: 'text/event-stream',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new Error(openRouterHttpErrorText(response.status, await response.text().catch(() => ''), pinnedSlug));
			}
			if (!response.body) {
				throw new Error('OpenRouter 返回了空响应流');
			}
			await consumeOpenRouterSse(response.body, progress, token);
		} finally {
			cancellation.dispose();
		}
	}

	provideTokenCount(_model: OpenRouterModel, text: string | vscode.LanguageModelChatRequestMessage): Thenable<number> {
		if (typeof text === 'string') {
			return Promise.resolve(estimateTextTokens(text));
		}
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

	/** 估算一次请求里工具定义的 token 开销。 */
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

	/**
	 * 强制下一次重新拉取目录，并通知 VS Code 刷新（登录 / 登出后调用）。
	 *
	 * ⚠️ **只重置时间戳，不清空已拉到的目录**：OpenRouter 的模型目录是
	 * **公开且与 key 无关**的（谁查都一样），所以"稍旧"永远不等于"错"；
	 * 而清空会让「登录后紧接着的一次瞬时网络故障」把模型列表变成空的
	 * （用户刚设置完 key，却什么都看不到）。
	 */
	refreshModels(): void {
		this.catalogLoadedAt = 0;
		this.changeEmitter.fire();
	}

	dispose(): void {
		this.changeEmitter.dispose();
	}

	/**
	 * 拉取模型目录 + 逐模型上游端点。
	 *
	 * ⚠️ **失败语义**（有意为之）：
	 * - 认证失败（401/403）**直接抛** —— 这是用户必须动手修的状态，藏起来只会
	 *   让模型选择器莫名其妙地空着；
	 * - 其它失败（网络抖动等）：**有旧目录就沿用旧目录**（宁可展示稍旧的目录，
	 *   也不要空列表）；**没有旧目录才抛** —— 否则用户什么都看不到、也没有任何提示。
	 */
	private async loadCatalog(credential: OpenRouterCredential, token: vscode.CancellationToken): Promise<void> {
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			const all = parseOpenRouterModels(await this.fetchCatalog(credential, controller.signal));
			const selected = selectOpenRouterModels(all);
			// ⚠️ 必须**逐模型**再查一次端点：`/models` 的返回里没有供应商信息。
			const providerLists = await Promise.all(selected.map(async (model) => {
				try {
					return parseOpenRouterProviders(await this.fetchProviders(model.id, credential, controller.signal));
				} catch {
					// 单个模型查不到上游**不得**拖垮整个目录：
					// 该模型只是少了「上游供应商」选项，其余照常可用。
					return [];
				}
			}));
			this.catalog = selected.map((model, index) => ({
				model,
				providerOptions: providerLists[index] ?? [],
			}));
		} catch (error) {
			if (token.isCancellationRequested) {
				throw error;
			}
			const status = /HTTP (\d+)/.exec(messageOf(error));
			const isAuthFailure = status !== null && isOpenRouterAuthStatus(Number(status[1]));
			if (isAuthFailure || this.catalog === undefined) {
				// 认证失败：用户必须动手修，藏起来只会让模型选择器莫名其妙地空着。
				// 没有旧目录：抛出去，否则用户什么都看不到、也没有任何提示。
				throw error;
			}
			// 有旧目录：沿用（宁可展示稍旧的目录，也不要空列表）。
		} finally {
			cancellation.dispose();
			// ⚠️ 失败时也要盖时间戳：否则坏网络下每次打开模型选择器都会重发一轮请求。
			this.catalogLoadedAt = Date.now();
		}
	}
}

/** 组装模型选择器里的一个模型。 */
function toChatModel(entry: CatalogEntry): OpenRouterModel {
	const efforts = openRouterEffortsOf(entry.model.reasoning);
	const defaultEffort = openRouterDefaultEffort(entry.model.reasoning, efforts);
	return {
		id: entry.model.id,
		name: entry.model.name,
		family: entry.model.id,
		version: '1',
		detail: 'OpenRouter',
		maxInputTokens: entry.model.contextLength,
		maxOutputTokens: entry.model.maxOutputTokens,
		capabilities: {
			imageInput: entry.model.imageInput,
			toolCalling: entry.model.toolCalling,
		},
		providerOptions: entry.providerOptions,
		efforts,
		configurationSchema: openRouterConfigurationSchema(efforts, defaultEffort),
	};
}

/**
 * 生成模型配置 schema。**只声明「思考强度」一项**。
 *
 * ⚠️⚠️ **不要在这里加「上游供应商」**（试过，失败了）。VS Code 的模型选择器
 * 只认两个固定槽位（`navigation` = 思考强度 / `tokens` = 上下文），且同一槽位
 * **只取一个属性**、`navigation` 里又以 `reasoningEffort` 为别名优先命中项
 * ⇒ 再加一个 `group: 'navigation'` 的 `provider` 属性**永远取不到**；
 * 改自定义 group 名则根本不会被遍历。完整的源码依据见 `openrouter-settings.ts`。
 *
 * ⚠️ 更隐蔽的一点：`provider` 若留在 `properties` 里，**在「没有思考档位」的模型上
 * 会反过来占住 `navigation` 槽**（那时没有 `reasoningEffort` 去命中别名，遍历会
 * 按 schema 顺序取到它）—— 同一个属性在不同模型上时隐时现，语义完全不可预测。
 * 所以这里直接不声明它。上游绑定改走**设置 + 命令**（`openrouter-settings.ts`）。
 *
 * ⚠️ `default` 只在与 `enum` 一致时才写：给一个不在枚举里的默认值会让
 * 选择器显示一个选不中的档位。
 */
function openRouterConfigurationSchema(
	efforts: readonly string[],
	defaultEffort: string | undefined,
): vscode.LanguageModelConfigurationSchema | undefined {
	if (efforts.length === 0) {
		return undefined;
	}
	return {
		properties: {
			reasoningEffort: {
				type: 'string',
				title: '思考强度',
				enum: [...efforts],
				enumItemLabels: efforts.map((effort) => OPENROUTER_EFFORT_NAMES[effort] ?? effort),
				...(defaultEffort === undefined ? {} : { default: defaultEffort }),
				group: 'navigation',
			},
		},
	};
}

/** 组装真实 provider 实例（凭据从 `SecretStorage` 读，上游绑定从 VS Code 设置读）。 */
export function createOpenRouterProvider(
	secrets: vscode.SecretStorage,
	secretKey: string,
): OpenRouterChatProvider {
	return new OpenRouterChatProvider({
		resolveCredential: () => readOpenRouterCredential(secrets, secretKey),
		readPinnedProvider: (modelId) => readPinnedProviders()[modelId],
	});
}
