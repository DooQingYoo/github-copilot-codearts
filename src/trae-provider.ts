// TRAE（字节跳动 TRAE IDE）的 VS Code 语言模型 Chat Provider。
//
// 把 TRAE 的 SOLO 推理链路（`llm_utils_chat`）接入 VS Code Copilot Chat。
//
// ## 关键协议点（踩过的坑，改动时务必保留）
//
// 1. **载荷必须转换**：OpenAI 的 `{model, messages, tools, tool_choice, stream}`
//    要映射为 SOLO 格式（`function` / `config_name` / `function_call` /
//    `parameters` 序列化为字符串），不能透传。
// 2. **响应是自定义 SSE**（`event:output` / `token_usage` / `done` / `error`），
//    不是 OpenAI 标准帧，需独立解析。
// 3. **模型只在列出它的通道里可调用**：发错 `function` 会得到流内 `4001`。
// 4. **`tools.parameters` 必须是 JSON 字符串**（OpenAI 标准是对象）。
// 5. **图片走多模态 parts 原样透传**（`{type:'image_url',image_url:{url}}`），
//    实测上游直接接受，无需额外协议转换。

import * as vscode from 'vscode';
import {
	TRAE_CHANNELS,
	TRAE_MAX_CONTEXT_TOKENS,
	clampTraeMaxTokens,
	isTraeModelCallable,
	parseTraeBatchModelList,
	parseTraeSSELine,
	traeMaxModeFields,
	traeSOLOHeaders,
	traeStreamErrorMessage,
	traeUsageFromTokenUsage,
	transformToSOLOBody,
	type TraeCredential,
	type TraeReasoningConfig,
	type TraeRemoteModel,
} from './trae';
import { fetchTraeModels, resolveTraeCredential } from './trae-auth';
import { classifyTraeError, isTraeQuotaError } from './trae-errors';

/** 上游对话端点。 */
const TRAE_CHAT_URL = 'https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat';

/** 目录缓存有效期（毫秒）。 */
const CATALOG_TTL_MS = 5 * 60_000;

/**
 * 统一日志前缀。
 *
 * ⚠️ 用 `console.log` 而不是 `vscode.window.createOutputChannel`：前者直接进
 * 「调试控制台 / Extension Host 日志」，排障时无需用户额外打开面板。
 * 全部日志都带 `[TRAE]` 前缀，便于在混杂输出里过滤。
 */
const LOG_PREFIX = '[TRAE]';

/** 打印一条诊断日志（**只用于排障**，不承载业务逻辑）。 */
function log(...args: unknown[]): void {
	console.log(LOG_PREFIX, ...args);
}

/** 打印一条警告日志。 */
function logWarn(...args: unknown[]): void {
	console.warn(LOG_PREFIX, ...args);
}

/** 安全地把任意值转成可读短串（避免把整个响应体刷进日志）。 */
function brief(value: unknown, max = 300): string {
	let text: string;
	try {
		text = typeof value === 'string' ? value : JSON.stringify(value);
	} catch {
		text = String(value);
	}
	if (text === undefined) {return 'undefined';}
	return text.length > max ? `${text.slice(0, max)}…(共 ${text.length} 字符)` : text;
}

/**
 * 汇总远端目录响应的**结构**，用于排障「模型列表不对」。
 *
 * 输出每个 `function` 的条目数与**被过滤掉的原因计数** —— 只看「最终剩几个」
 * 无法区分「上游没下发」与「被我们的白名单/过滤条件剔掉了」。
 */
export function describeTraeCatalog(payload: unknown): string {
	if (typeof payload !== 'object' || payload === null) {
		return `响应不是对象（${typeof payload}）`;
	}
	const record = payload as Record<string, unknown>;
	const groups = record.function_configs ?? record.FunctionConfigs;
	if (!Array.isArray(groups)) {
		return `响应里没有 function_configs 数组；顶层键=${Object.keys(record).join(',')}`;
	}
	const lines: string[] = [`function_configs 共 ${groups.length} 组`];
	for (const group of groups) {
		if (typeof group !== 'object' || group === null) {continue;}
		const g = group as Record<string, unknown>;
		const channel = String(g.function ?? g.Function ?? '(未声明)');
		const list = g.config_info_list ?? g.ConfigInfoList;
		const count = Array.isArray(list) ? list.length : 0;
		const inWhitelist = TRAE_CHANNELS.includes(channel);
		lines.push(`  ${channel}: ${count} 条${inWhitelist ? '' : '（不在白名单，整组丢弃）'}`);
	}
	return lines.join('\n');
}

/**
 * 推理档位 wire 值 → 展示名。
 *
 * ⚠️ TRAE 的 `reasoning_effort_config.options` 是**单值**（`light` / `high` /
 * `extra_high` …），该字符串既是产品侧档位名、也是发给上游的取值，故本表
 * **只用于展示**，不做 wire 映射。未登记的取值回退原样显示。
 */
const TRAE_EFFORT_NAMES: Readonly<Record<string, string>> = {
	light: '轻',
	minimal: '最小',
	low: '低',
	medium: '中',
	high: '高',
	extra_high: '极高',
	xhigh: '极高',
	max: '最大',
};

/**
 * 推理档位强度序（数值越大越强）。
 *
 * ⚠️ **只用于挑「默认档」，不参与 wire 取值** —— wire 值就是远端
 * `options` 里的字符串本身。
 */
const TRAE_EFFORT_RANK: Readonly<Record<string, number>> = {
	minimal: 0,
	light: 1,
	low: 2,
	medium: 3,
	high: 4,
	extra_high: 5,
	xhigh: 6,
	max: 7,
};

/**
 * 兜底模型目录（远端不可用时使用）。
 *
 * 来源：参考实现 `trae-product.ts` 的 `TRAE_FALLBACK_MODELS`（2026-08 实测快照），
 * 已剔除 `isHidden` 的内部条目。
 *
 * ⚠️ `contextWindow` 是**估值**（采信实测主流值 200000）；远端可用时完全采信远端。
 */
const TRAE_FALLBACK_MODELS: readonly { id: string; name: string; contextWindow: number }[] = [
	{ id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek V4 Flash Official', contextWindow: 200_000 },
	{ id: 'Doubao-Seed-2.1-Pro', name: 'Doubao Seed 2.1 Pro', contextWindow: 200_000 },
	{ id: 'seed-code-pro-0430', name: 'Seed Code Pro 0430', contextWindow: 200_000 },
	{ id: 'Doubao-Seed-2.1-Turbo', name: 'Doubao Seed 2.1 Turbo', contextWindow: 200_000 },
	{ id: 'Doubao-Seed-2.0-Code', name: 'Doubao Seed 2.0 Code', contextWindow: 200_000 },
	{ id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200_000 },
	{ id: 'glm-5-turbo', name: 'GLM-5 Turbo', contextWindow: 200_000 },
	{ id: 'glm-5', name: 'GLM-5', contextWindow: 200_000 },
	{ id: 'DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro', contextWindow: 200_000 },
	{ id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash', contextWindow: 200_000 },
	{ id: 'kimi-k3', name: 'Kimi K3', contextWindow: 200_000 },
	{ id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 200_000 },
	{ id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 200_000 },
	{ id: 'minimax-m3', name: 'MiniMax M3', contextWindow: 200_000 },
	{ id: 'qwen-3.7-plus', name: 'Qwen 3.7 Plus', contextWindow: 200_000 },
];

/** 兜底输出上限（远端不可用时）。 */
const TRAE_FALLBACK_MAX_OUTPUT_TOKENS = 32_000;

interface TraeModel extends vscode.LanguageModelChatInformation {
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
 * 转发模型思维链（`reasoning_content`）到 Copilot 的「思考过程」块。
 *
 * ⚠️ `LanguageModelThinkingPart` 属 **proposed API**（类型见
 * `src/vscode.proposed.languageModelThinkingPart.d.ts`）。运行时若不支持则
 * **静默跳过** —— 思考链是增强功能，绝不能因为它导致整轮请求失败。
 */
function reportThinking(
	text: unknown,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	if (typeof text !== 'string' || text.length === 0) {return;}
	const ThinkingPart = (vscode as unknown as {
		LanguageModelThinkingPart?: new (value: string | string[], id?: string) => unknown;
	}).LanguageModelThinkingPart;
	if (ThinkingPart === undefined) {return;}
	progress.report(new ThinkingPart(text) as unknown as vscode.LanguageModelResponsePart);
}

/**
 * 向 Copilot Chat 上报真实 token 用量。
 *
 * ⚠️ Copilot 的上下文占用指示器（「N/M 个令牌」）**只读 `usage.promptTokens`**：
 * 它的分子是 `promptTokens + completionTokens`，而第三方 provider 无法通过
 * `provideTokenCount` 影响它。上报通道是 `LanguageModelDataPart` + **MIME `'usage'`**，
 * 载荷为 OpenAI 形状的 usage JSON；缺少它时界面恒显示 `0/窗口`。
 *
 * ⚠️ 这里用 **OpenAI 口径**（`prompt_tokens` 含缓存），与 DSH 的互斥口径不同 ——
 * 见 `trae.ts` 的 `traeUsageFromTokenUsage` 注释。
 */
function reportUsage(
	usage: ReturnType<typeof traeUsageFromTokenUsage>,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	progress.report(
		new vscode.LanguageModelDataPart(
			new TextEncoder().encode(JSON.stringify({
				prompt_tokens: usage.promptTokens,
				completion_tokens: usage.completionTokens,
				total_tokens: usage.totalTokens,
				prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
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

/** OpenAI 传输格式的消息。 */
interface OpenAiMessage {
	role: string;
	content?: string | Array<Record<string, unknown>> | null;
	tool_call_id?: string;
	tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

/**
 * 把 VS Code 消息转成 SOLO 端点的 `messages[]`。
 *
 * ⚠️ **必须保留 assistant 的 `tool_calls` 与 `tool` 的 `tool_call_id`**：
 * 只发工具结果而不发对应的 assistant 调用，会让模型看不到自己调用过什么 ——
 * 表现为反复重调同一工具或凭空编造结果。
 *
 * ⚠️ **带图消息的 content 是多模态数组**，不能压成纯文本（否则图片丢失）。
 *
 * ⚠️ **工具结果必须紧跟其 assistant `tool_calls`**：上游要求 `role:'tool'`
 * 是「紧跟其 assistant tool_calls 的应答」，两者之间插任何消息都会被拒
 * （实测 `code=4027 Messages with role 'tool' must be a response to a preceding
 * message with 'tool_calls'`）。故这里把工具结果**就地**展开在 assistant 之后，
 * 而把同一条 user 消息的正文/图片**延后**到工具结果之后。
 */
export function messagesToTrae(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAiMessage[] {
	const output: OpenAiMessage[] = [];
	for (const message of messages) {
		const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
		const parts: Array<Record<string, unknown>> = [];
		const toolCalls: NonNullable<OpenAiMessage['tool_calls']> = [];
		const toolResults: OpenAiMessage[] = [];
		let index = 0;
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				if (part.value.length > 0) {parts.push({ type: 'text', text: part.value });}
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
		const isEmpty = typeof merged === 'string' && merged.length === 0 && !hasImage;
		// ⚠️ 带工具结果时，本消息的正文/图片必须**延后**到 `role:'tool'` 之后
		// （成因见函数头注释的 4027 记录）。
		const deferred = toolResults.length > 0;
		if (!deferred && (!isEmpty || toolCalls.length > 0)) {
			output.push({
				role,
				content: merged,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
		} else if (deferred && toolCalls.length > 0) {
			// 极少见：同一条消息既有工具调用又有工具结果。先发调用，结果随后。
			output.push({ role, content: merged, tool_calls: toolCalls });
		}
		output.push(...toolResults);
		if (deferred && !isEmpty) {
			output.push({ role, content: merged });
		}
	}
	return output;
}

/** 把 VS Code 工具定义转成 SOLO 顶层 `tools`。 */
export function traeTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): unknown[] | undefined {
	if (!tools?.length) {return undefined;}
	return tools.map((tool) => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema,
		},
	}));
}

/**
 * 挑默认思考档：**上游 `default_level` 优先**，缺失或非法才退到最强档。
 *
 * ## 为什么是「采信上游」而不是自己定规则
 *
 * 一律取最强档会让每次请求都顶格思考 —— 思考 token **计入
 * `completion_tokens`**，与正文共享额度，于是正文更早撞 `max_tokens`、首字更慢。
 * 实测上游在多数模型上给的就是次高档 `high`，而在 `glm-5.3` / `kimi-k3` 上
 * 自己选的是最高档 —— 故以**上游的判断**为准，而不是自己定一条规则。
 *
 * ⚠️ `default_level` 是**外部输入**，必须校验它真的在 `options` 里：给一个
 * 不存在的档位会被上游以非法参数拒绝。实测上游确实会下发
 * `default_level: 'max'` 而 `options` 里没有 `max` —— 此时必须退到兜底档。
 */
export function defaultTraeEffort(
	config: TraeReasoningConfig,
	fallback: string | undefined,
): string | undefined {
	const declared = config.defaultLevel;
	if (declared !== undefined && declared.length > 0 && config.options.includes(declared)) {
		return declared;
	}
	return fallback;
}

/** 从 `options` 里挑**最强**的一档作兜底默认值。 */
export function strongestTraeEffort(options: readonly string[]): string | undefined {
	if (options.length === 0) {return undefined;}
	if (options.includes('max')) {return 'max';}
	let best: string | undefined;
	let bestRank = -1;
	for (const option of options) {
		const rank = TRAE_EFFORT_RANK[option];
		if (rank !== undefined && rank > bestRank) {
			best = option;
			bestRank = rank;
		}
	}
	// 全都未登记（上游新增了档位）→ 取数组最后一项（远端按强度升序给出）。
	return best ?? options[options.length - 1];
}

/** 为模型生成思考强度选择器的 schema（无档位时返回 undefined）。 */
function traeConfigurationSchema(
	config: TraeReasoningConfig | undefined,
): vscode.LanguageModelConfigurationSchema | undefined {
	if (config === undefined) {return undefined;}
	if (config.supportThinking === false) {return undefined;}
	if (config.options.length === 0) {return undefined;}
	const efforts = [...config.options];
	const fallback = strongestTraeEffort(efforts);
	const chosen = defaultTraeEffort(config, fallback);
	return {
		properties: {
			reasoningEffort: {
				type: 'string',
				title: '思考强度',
				enum: efforts,
				enumItemLabels: efforts.map((effort) => TRAE_EFFORT_NAMES[effort] ?? effort),
				...(chosen === undefined ? {} : { default: chosen }),
				group: 'navigation',
			},
		},
	};
}

/** 组装模型选择器里展示的名字：`模型名 · 倍率`。 */
export function traeDisplayName(model: TraeRemoteModel): string {
	const rate = model.creditsRate;
	if (rate === undefined) {return model.name;}
	// `0` 是**合法**倍率（免费），必须与「没有倍率」区分开。
	const current = rate === 0 ? '免费' : `x${rate}`;
	const original = model.originalCreditsRate;
	if (original !== undefined && original > rate) {
		return `${model.name} · x${original}→${current}`;
	}
	return `${model.name} · ${current}`;
}

/** `TraeChatProvider` 的构造选项。 */
export interface TraeChatProviderOptions {
	/** 凭据解析（含静默续期）。 */
	resolveCredential: () => Promise<TraeCredential | undefined>;
	/** 拉取远端模型目录（失败时抛错，由 provider 回退兜底表）。 */
	fetchModels?: (credential: TraeCredential) => Promise<unknown>;
	/** 注入的 fetch（测试用）；默认为全局 fetch。 */
	fetcher?: typeof fetch;
}

/** TRAE 的 VS Code 语言模型 Chat Provider。 */
export class TraeChatProvider implements vscode.LanguageModelChatProvider<TraeModel>, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

	/** 远端模型目录（含**空结果**缓存，避免未登录时反复发请求）。 */
	private remoteModels: TraeRemoteModel[] | undefined;
	private catalogLoadedAt = 0;

	constructor(private readonly options: TraeChatProviderOptions) {}

	private get fetcher(): typeof fetch {
		return this.options.fetcher ?? fetch;
	}

	/** 远端模型元数据索引（用于通道 / 上下文窗口 / 档位查询）。 */
	private get remoteMeta(): ReadonlyMap<string, TraeRemoteModel> {
		return new Map((this.remoteModels ?? []).map((model) => [model.id, model]));
	}

	/**
	 * 该模型所属的聊天通道（`function`）。
	 *
	 * ⚠️ **模型只在列出它的通道里可调用**：发错通道上游会回流内
	 * `code=4001 param is invalid`。远端目录里每条模型都带自己的 `function`；
	 * 查不到时回退默认通道（`solo_work_lite`，已在白名单内）。
	 */
	private channelFor(model: string): string {
		const channel = this.remoteMeta.get(model)?.function;
		return channel !== undefined && channel.length > 0 ? channel : 'solo_work_lite';
	}

	/** 该模型本次是否启用 **Max 模式**（1M 上下文）。 */
	private maxModeFor(model: string): boolean {
		return this.remoteMeta.get(model)?.maxMode === true;
	}

	/** 模型的上下文窗口：远端优先，兜底表次之。 */
	private contextWindowFor(model: string): number {
		const meta = this.remoteMeta.get(model);
		if (this.maxModeFor(model)) {
			return meta?.maxContextWindow ?? TRAE_MAX_CONTEXT_TOKENS;
		}
		return meta?.contextWindow
			?? TRAE_FALLBACK_MODELS.find((m) => m.id === model)?.contextWindow
			?? 200_000;
	}

	/** 模型的输出上限：远端优先 → 兜底值。 */
	private maxOutputTokensFor(model: string): number {
		const meta = this.remoteMeta.get(model);
		if (this.maxModeFor(model) && meta?.maxModeOutputTokens !== undefined) {
			return meta.maxModeOutputTokens;
		}
		return meta?.maxOutputTokens ?? TRAE_FALLBACK_MAX_OUTPUT_TOKENS;
	}

	/** 完整模型目录（远端优先，失败回退兜底表）。 */
	listModels(): TraeModel[] {
		const source: readonly TraeRemoteModel[] = this.remoteModels === undefined
			? TRAE_FALLBACK_MODELS.map((model) => ({ id: model.id, name: model.name, contextWindow: model.contextWindow }))
			: this.remoteModels.filter((model) => isTraeModelCallable(model) && model.isHidden !== true);
		return source.map((model) => this.toModel(model));
	}

	private toModel(model: TraeRemoteModel): TraeModel {
		return {
			id: model.id,
			name: traeDisplayName(model),
			family: model.id,
			version: '1',
			detail: 'TRAE (字节)',
			maxInputTokens: this.contextWindowFor(model.id),
			maxOutputTokens: this.maxOutputTokensFor(model.id),
			capabilities: {
				// ⚠️ 逐模型判定（远端 `display_config.multimodal`）：未声明时**保守
				// 报 false**（兜底表没有该字段，且「远端没说」不等于「远端支持」）。
				imageInput: model.multimodal === true,
				toolCalling: true,
			},
			configurationSchema: traeConfigurationSchema(model.reasoningConfig),
		};
	}

	async provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		token: vscode.CancellationToken,
	): Promise<TraeModel[]> {
		log(`provideLanguageModelChatInformation: silent=${String(options.silent)}`);
		const credential = await this.options.resolveCredential().catch((error: unknown) => {
			logWarn('resolveCredential 失败：', error instanceof Error ? error.message : String(error));
			return undefined;
		});
		if (credential === undefined) {
			log('无凭据 → 返回空列表（请先登录）');
			return [];
		}
		log(`凭据 uid=${credential.uid} machine_id=${credential.machine_id.slice(0, 8)}…`);
		// ⚠️ **silent 路径也必须拉目录**：`silent` 只表示「不要弹窗/不要触发登录」，
		// 不表示「不要网络」。早期实现让 silent 直接返回 `listModels()`，而那时
		// `remoteModels` 还是 undefined ⇒ 返回的是**内置兜底表**（旧模型），
		// 于是模型选择器里永远看不到远端的新模型（如 deepseek-v4.1-flash）。
		// 这与 CodeBuddy 的实现一致（它同样在 silent 下走 `loadModels`）。
		if (Date.now() - this.catalogLoadedAt > CATALOG_TTL_MS || this.remoteModels === undefined) {
			await this.loadModels(credential, token);
		}
		const models = this.listModels();
		log(`返回 ${models.length} 个模型：${models.map((m) => m.id).join(', ')}`);
		return models;
	}

	async provideLanguageModelChatResponse(
		model: TraeModel,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		log(`=== 对话开始 model=${model.id} 消息数=${messages.length} 工具数=${options.tools?.length ?? 0} ===`);
		const credential = await this.options.resolveCredential();
		if (credential === undefined) {
			logWarn('无凭据 → 抛错');
			throw new Error('请先运行“TRAE (字节): 登录 / 管理账号”');
		}

		const body = this.buildRequestBody(model, messages, options);
		const bodyText = JSON.stringify(body);
		log(`请求体 ${bodyText.length} 字符；function=${String(body.function)} config_name=${String(body.config_name)}`);
		log(`请求体预览：${brief(bodyText, 1500)}`);

		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			log(`POST ${TRAE_CHAT_URL}`);
			const response = await this.fetcher(TRAE_CHAT_URL, {
				method: 'POST',
				headers: new Headers(traeSOLOHeaders(credential, true)),
				body: bodyText,
				signal: controller.signal,
			});
			log(`HTTP ${response.status} ${response.statusText} content-type=${response.headers.get('content-type') ?? '(无)'}`);
			if (!response.ok) {
				const detail = await response.text().catch(() => '');
				logWarn(`HTTP 非 2xx，响应体：${brief(detail, 2000)}`);
				const kind = classifyTraeError(response.status, detail);
				logWarn(`错误分类：${kind}`);
				if (isTraeQuotaError(kind)) {
					throw new Error(`TRAE 额度不足（HTTP ${response.status}）：${detail.slice(0, 500)}`);
				}
				throw new Error(`TRAE HTTP ${response.status}: ${detail.slice(0, 1000)}`);
			}
			if (!response.body) {
				logWarn('响应没有 body');
				throw new Error('TRAE 返回了空响应流');
			}
			await consumeTraeSse(response.body, progress, token, model.id);
			log('=== 对话结束（正常） ===');
		} catch (error) {
			logWarn('=== 对话失败 ===', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
			if (error instanceof Error && error.stack !== undefined) {logWarn(error.stack);}
			throw error;
		} finally {
			cancellation.dispose();
		}
	}

	/** 构造一次 SOLO 对话请求体。 */
	private buildRequestBody(
		model: TraeModel,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
	): Record<string, unknown> {
		const openaiBody: Record<string, unknown> = {
			model: model.id,
			messages: messagesToTrae(messages),
			stream: true,
		};
		const tools = traeTools(options.tools);
		if (tools !== undefined) {
			openaiBody.tools = tools;
			if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
				openaiBody.tool_choice = 'required';
			}
		}
		// 输出额度收敛到上游安全上限（默认 64000）：客户端索要 131072 会把上游
		// 直接打成 4xx。
		const maxTokens = clampTraeMaxTokens(model.maxOutputTokens);
		if (maxTokens !== undefined) {openaiBody.max_tokens = maxTokens;}

		// 思考强度：把模型选择器里选中的档位透传为 `reasoning_effort`。
		// ⚠️ 必须再校验一次（用户选择可能来自缓存的旧目录，发未知档位会被上游拒）。
		const requestedEffort = options.modelConfiguration?.reasoningEffort;
		const declared = this.remoteMeta.get(model.id)?.reasoningConfig;
		if (typeof requestedEffort === 'string' && declared !== undefined
			&& declared.supportThinking !== false && declared.options.includes(requestedEffort)) {
			openaiBody.reasoning_effort = requestedEffort;
		}

		// Max 模式（1M 上下文）：成套覆盖 `max_tokens` / `prompt_max_tokens` /
		// `context_window_size` 并注入 `strategy=max`。
		// ⚠️ 必须在 `clampTraeMaxTokens` **之后**执行：Max 会话的输出上限由远端
		// `__max` 明细声明（可能高于 64K 安全线）。
		if (this.maxModeFor(model.id)) {
			const meta = this.remoteMeta.get(model.id);
			Object.assign(
				openaiBody,
				traeMaxModeFields(meta?.maxContextWindow ?? TRAE_MAX_CONTEXT_TOKENS, meta?.maxModeOutputTokens),
			);
		}

		// 一次性完成 OpenAI → SOLO 转换（含 messages 规范化、tools 序列化、
		// tool_choice 归一化、config_name 注入），并**按模型路由通道**。
		return transformToSOLOBody(openaiBody, this.channelFor(model.id));
	}

	provideTokenCount(_model: TraeModel, text: string | vscode.LanguageModelChatRequestMessage): Thenable<number> {
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

	/** 估算一次请求里工具定义的 token 开销（与其它 provider 保持同一口径）。 */
	estimateToolTokens(tools: readonly vscode.LanguageModelChatTool[] | undefined): number {
		if (!tools?.length) {return 0;}
		let total = BASE_TOKENS_PER_TOOL_SET;
		for (const tool of tools) {
			total += BASE_TOKENS_PER_TOOL + estimateTextTokens(JSON.stringify(tool));
		}
		return total;
	}

	refreshModels(): void {
		this.remoteModels = undefined;
		this.catalogLoadedAt = 0;
		this.changeEmitter.fire();
	}

	dispose(): void {
		this.changeEmitter.dispose();
	}

	/** 拉取远端目录；失败时**保留兜底表**（不抛错，目录失败不该让选择器不可用）。 */
	private async loadModels(credential: TraeCredential, token: vscode.CancellationToken): Promise<void> {
		const fetchModels = this.options.fetchModels;
		if (fetchModels === undefined) {
			logWarn('loadModels: 未注入 fetchModels → 保持兜底表');
			return;
		}
		log('loadModels: 开始拉取远端目录…');
		try {
			const payload = await fetchModels(credential);
			if (token.isCancellationRequested) {
				log('loadModels: 已取消');
				return;
			}
			log(`loadModels: 响应结构\n${describeTraeCatalog(payload)}`);
			const models = parseTraeBatchModelList(payload);
			log(`loadModels: 解析出 ${models.length} 个模型：${models.map((m) => m.id).join(', ')}`);
			if (models.length === 0) {
				logWarn('loadModels: 解析结果为空 → 回退兜底表（模型列表会显示旧模型）');
			}
			// ⚠️ 空结果**也要缓存**（连同时间戳）：未登录 / 上游异常时若保持
			// `undefined`，下一次 `listModels` 会再拉一次，用户每打开一次模型
			// 选择器就发一次真实 HTTP 请求。
			this.remoteModels = models.length > 0 ? models : undefined;
		} catch (error) {
			logWarn('loadModels 失败：', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
			if (error instanceof Error && error.stack !== undefined) {logWarn(error.stack);}
			// 失败：保持兜底表（`remoteModels` 仍为 undefined）。
		} finally {
			this.catalogLoadedAt = Date.now();
		}
	}
}

/**
 * 消费 SOLO 自定义 SSE 流，向 `progress` 报告文本、思考与工具调用。
 *
 * 事件格式：
 * ```
 * event:output
 * data:{"response":"<增量>","reasoning_content":"<思考增量>","tool_calls":<null|数组>}
 *
 * event:token_usage
 * data:{"prompt_tokens":21,"completion_tokens":142,...}
 *
 * event:done
 * data:{"finish_reason":"stop"}
 *
 * event:error
 * data:{"code":4008,"message":"quota exceeded"}
 * ```
 */
export async function consumeTraeSse(
	body: ReadableStream<Uint8Array>,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	token: vscode.CancellationToken,
	modelId: string,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let currentEvent = '';
	let currentData = '';
	const toolCalls = new Map<number, PendingToolCall>();
	/** 是否已产出过任何内容（用于判断流内错误是否可安全重试）。 */
	let gotAnyContent = false;

	const emitEvent = (): void => {
		if (currentEvent.length === 0) {return;}
		const ev = parseTraeSSELine(currentEvent, currentData);
		// ⚠️ 逐事件打印（截断）：排障「对话报错」时这是第一手证据 ——
		// 上游用 HTTP 200 + 流内 `event:error` 下发错误，不看这里就完全看不到原因。
		log(`SSE event=${currentEvent} data=${brief(currentData, 500)}`);
		currentEvent = '';
		currentData = '';
		if (ev === undefined) {return;}
		switch (ev.event) {
			case 'output': {
				if (ev.response !== undefined && ev.response.length > 0) {
					gotAnyContent = true;
					progress.report(new vscode.LanguageModelTextPart(ev.response));
				}
				// ⚠️ 思维链与 `response` **并列**，老实现只读 `response` 会整个丢弃。
				reportThinking(ev.reasoningContent, progress);
				if (ev.toolCalls !== undefined && ev.toolCalls.length > 0) {
					gotAnyContent = true;
					for (const call of ev.toolCalls) {
						if (!isRecord(call)) {continue;}
						const wireIndex = typeof call.index === 'number' ? call.index : 0;
						const current = toolCalls.get(wireIndex) ?? { id: '', name: '', arguments: '' };
						if (typeof call.id === 'string' && call.id.length > 0) {current.id = call.id;}
						if (isRecord(call.function)) {
							if (typeof call.function.name === 'string' && call.function.name.length > 0) {
								current.name = call.function.name;
							}
							if (typeof call.function.arguments === 'string') {
								current.arguments += call.function.arguments;
							}
						}
						toolCalls.set(wireIndex, current);
					}
				}
				break;
			}
			case 'token_usage': {
				if (ev.usage !== undefined) {
					reportUsage(traeUsageFromTokenUsage(ev.usage), progress);
				}
				break;
			}
			case 'error': {
				if (ev.errorCode !== undefined && ev.errorMessage !== undefined) {
					// ⚠️ 上游**确实**用流内 `event:error` 下发错误（HTTP 仍是 200）。
					// 已有输出时如实抛出（绝不重放，防重复计费与重复执行工具）。
					throw new Error(traeStreamErrorMessage(ev.errorCode, ev.errorMessage, modelId));
				}
				break;
			}
			default:
				// metadata / timing_cost / extra_info / done：无需处理。
				break;
		}
	};

	try {
		for (;;) {
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
				// 空行 = 事件分隔符。
				if (line.trim().length === 0) {
					emitEvent();
					continue;
				}
				const trimmed = line.trim();
				if (trimmed.startsWith('event:')) {
					currentEvent = trimmed.slice(6).trim();
				} else if (trimmed.startsWith('data:')) {
					// SOLO 的 data 可能跨行拼接。
					currentData += trimmed.slice(5);
				}
				// 注释行（":"）忽略。
			}
		}
		buffer += decoder.decode();
		if (buffer.trim().length > 0) {
			const trimmed = buffer.trim();
			if (trimmed.startsWith('event:')) {
				currentEvent = trimmed.slice(6).trim();
			} else if (trimmed.startsWith('data:')) {
				currentData += trimmed.slice(5);
			}
		}
		emitEvent();
	} finally {
		reader.releaseLock();
	}

	// 工具调用在流结束后统一上报（参数是分片到达的，必须合并后再解析）。
	for (const call of toolCalls.values()) {
		if (!call.id || !call.name) {continue;}
		let input: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(call.arguments || '{}');
			if (!isRecord(parsed)) {throw new Error('工具参数必须是 JSON 对象');}
			input = parsed;
		} catch {
			throw new Error(`TRAE 返回了无效的工具参数：${call.name}`);
		}
		progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
	}
	// ⚠️ 一个事件都没收到 = 上游静默结束事件流，属于**可重试的瞬时故障**，
	// 不是「模型决定不说话」。抛错让 Copilot 的常规重试机制接管。
	if (!gotAnyContent && toolCalls.size === 0) {
		throw new Error('TRAE 上游未返回任何内容（空响应）');
	}
}

/** 便捷工厂：用 SecretStorage + 默认凭据键构造 provider。 */
export function createTraeProvider(
	secrets: vscode.SecretStorage,
	secretKey: string,
): TraeChatProvider {
	return new TraeChatProvider({
		resolveCredential: () => resolveTraeCredential(secrets, secretKey),
		fetchModels: (credential) => fetchTraeModels(credential),
	});
}
