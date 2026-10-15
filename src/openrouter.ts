// OpenRouter 协议常量与纯函数。
//
// ## 为什么这里比其他三家多一个「上游供应商」选项
//
// OpenRouter 是**聚合网关**：一个模型（如 `deepseek/deepseek-v4.1-flash`）背后有
// 几十家上游（DeepInfra / Fireworks / Together / Baidu / Alibaba …），默认按价格
// 加权做负载均衡。不指定时命中的上游可能是用户不想要的那家，而且是**静默**的
// （只有响应体里的 `provider` 字段才写得出答案）。所以本插件把上游做成模型级选项。
//
// ⚠️ 供应商是**两级目录**：`GET /models` 的返回里**没有**供应商信息，
// 必须再查 `GET /models/{author}/{slug}/endpoints`（见 `openRouterEndpointsUrl`）。
// 只查第一级会把「选择上游」做成空选项。
//
// ## 协议速览（**标准 OpenAI 兼容**，不需要伪装客户端）
//
// | 用途 | 方法 | 路径 | 认证 |
// |------|------|------|------|
// | 对话 | POST | `/api/v1/chat/completions` | `Bearer <API key>` |
// | 模型目录 | GET | `/api/v1/models` | 可匿名 |
// | 某模型的上游端点 | GET | `/api/v1/models/{author}/{slug}/endpoints` | 可匿名 |
// | 凭据自检 | GET | `/api/v1/key` | `Bearer <API key>` |
//
// ⚠️ `endpoints[].tag` 才是**路由用的 provider slug**（如 `deepinfra/fp4`、
// `fireworks/us`、`baseten/fp8`），`provider_name` 只是展示名，而且**会重名**
// —— 实测 `z-ai/glm-5.3-flash` 里 BaseTen 出现 3 次、Parasail 2 次、Fireworks 3 次
// （它们的 `tag` 各不相同）。下发给 `provider.order` 的必须是 `tag`。

/** OpenRouter API 基址。 */
export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
/** 对话端点（OpenAI 兼容）。 */
export const OPENROUTER_CHAT_URL = `${OPENROUTER_API_BASE}/chat/completions`;
/** 模型目录端点。 */
export const OPENROUTER_MODELS_URL = `${OPENROUTER_API_BASE}/models`;
/** 当前 API key 信息端点（用于登录时自检）。 */
export const OPENROUTER_KEY_URL = `${OPENROUTER_API_BASE}/key`;
/** 控制面请求超时（毫秒）；对话流式请求不适用。 */
export const OPENROUTER_REQUEST_TIMEOUT_MS = 30_000;

/** 兜底上下文窗口（目录里取不到时）。 */
export const OPENROUTER_FALLBACK_CONTEXT_TOKENS = 128_000;
/** 兜底最大输出（目录里取不到时）。 */
export const OPENROUTER_FALLBACK_MAX_OUTPUT_TOKENS = 16_000;

/**
 * 除「全部免费模型」之外，**额外展示**的收费模型（用户指定）。
 *
 * ⚠️ 必须写**完整 id**（作者/模型名）：OpenRouter 的模型 id 是带作者前缀的，
 * 写 `deepseek-v4.1-flash` 会匹配不到（目录里不存在这个 key）。
 */
export const OPENROUTER_PAID_MODEL_IDS: readonly string[] = [
	'deepseek/deepseek-v4.1-flash',
	'z-ai/glm-5.3-flash',
];

/** 思考档位 id → 展示名。 */
export const OPENROUTER_EFFORT_NAMES: Readonly<Record<string, string>> = {
	none: '关闭',
	minimal: '最小',
	low: '低',
	medium: '中',
	high: '高',
	xhigh: '极高',
	max: '最大',
};

/** 「自动」选项的值：不下发 `provider`，交回 OpenRouter 负载均衡。 */
export const OPENROUTER_PROVIDER_AUTO = 'auto';
/** 「自动」选项的展示名。 */
export const OPENROUTER_PROVIDER_AUTO_LABEL = '自动（OpenRouter 负载均衡）';

/** 目录里的一个模型（已解析，只保留本插件用得到的字段）。 */
export interface OpenRouterRemoteModel {
	/** 目录 id，如 `deepseek/deepseek-v4.1-flash` 或 `liquid/lfm-2.5-2.6b:free`。 */
	id: string;
	/** 展示名（即模型选择器默认名）。 */
	name: string;
	/** 上下文窗口（`context_length`）。 */
	contextLength: number;
	/** 最大输出（`top_provider.max_completion_tokens`）。 */
	maxOutputTokens: number;
	/** 是否接受图片输入（`architecture.input_modalities` 含 `image`）。 */
	imageInput: boolean;
	/** 是否支持工具调用（`supported_parameters` 含 `tools`）。 */
	toolCalling: boolean;
	/** 思考档位元数据（无则不可选档位）。 */
	reasoning?: OpenRouterReasoning;
}

/** `GET /models` 里的 `reasoning` 对象（只取本插件用得到的字段）。 */
export interface OpenRouterReasoning {
	/** 为 true 时模型不接受关闭思考，且不能再补 `none` 档位。 */
	mandatory: boolean;
	/** 允许的档位。⚠️ 上游按**降序**（最强在前）下发；`undefined`/`null` 表示无白名单。 */
	supportedEfforts?: readonly string[];
	/** 默认档位（映射到请求体的 `reasoning.effort`）。 */
	defaultEffort?: string;
	/** 未显式设置 `reasoning.enabled` 时的默认开关状态。 */
	defaultEnabled?: boolean;
}

/** 某模型可选的**上游供应商**。 */
export interface OpenRouterProviderOption {
	/** 路由 slug（`endpoints[].tag`）——下发给 `provider.order` 的就是它。 */
	slug: string;
	/** 展示名；同名供应商会被拼上 slug 后缀以便区分。 */
	label: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 是否为「免费模型」。
 *
 * ⚠️ 判据是 OpenRouter 自己的目录约定 —— **`:free` 变体后缀**，
 * 而不是「pricing 为 0」：`openrouter/free`（Free Models Router）也是 0 价，
 * 但它是随机挑模型的**路由**而不是具体模型（用户已明确要求排除它）。
 * `:batch` / `:nitro` / `~xxx-latest` 等其它变体也因此自然被排除。
 */
export function isOpenRouterFreeModelId(id: string): boolean {
	return id.endsWith(':free');
}

/** 是否为本插件要展示的模型：全部免费模型 + 用户指定的两个收费模型。 */
export function isOpenRouterDisplayModelId(id: string): boolean {
	return isOpenRouterFreeModelId(id) || OPENROUTER_PAID_MODEL_IDS.includes(id);
}

/**
 * 组装某模型的**上游端点**查询 URL。
 *
 * ⚠️ 按 **id 自身**切分作者/模型名（在第一个 `/` 处切），不要把目录里的
 * `links.details` 当来源：实测 `:free` 变体的 `links.details` 指向的是**基础模型**
 * 的 canonical slug（带日期），照它查会拿到「收费端点」而不是「免费端点」。
 *
 * ⚠️ slug 必须 `encodeURIComponent`：`:free` 里的冒号不编码时部分网关会 404。
 */
export function openRouterEndpointsUrl(modelId: string): string {
	const slash = modelId.indexOf('/');
	const author = slash === -1 ? modelId : modelId.slice(0, slash);
	const slug = slash === -1 ? '' : modelId.slice(slash + 1);
	return `${OPENROUTER_MODELS_URL}/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`;
}

/** 解析 `GET /models` 响应里的**一个**模型条目；形状不对时返回 undefined。 */
export function parseOpenRouterModel(item: unknown): OpenRouterRemoteModel | undefined {
	if (!isRecord(item)) {
		return undefined;
	}
	const id = typeof item.id === 'string' ? item.id : '';
	if (id.length === 0) {
		return undefined;
	}
	const name = typeof item.name === 'string' && item.name.length > 0 ? item.name : id;
	const architecture = isRecord(item.architecture) ? item.architecture : undefined;
	const inputModalities = Array.isArray(architecture?.input_modalities) ? architecture.input_modalities : [];
	const topProvider = isRecord(item.top_provider) ? item.top_provider : undefined;
	return {
		id,
		name,
		contextLength: positiveNumber(item.context_length, OPENROUTER_FALLBACK_CONTEXT_TOKENS),
		maxOutputTokens: positiveNumber(topProvider?.max_completion_tokens, OPENROUTER_FALLBACK_MAX_OUTPUT_TOKENS),
		imageInput: inputModalities.includes('image'),
		toolCalling: arrayOfStrings(item.supported_parameters).includes('tools'),
		reasoning: parseOpenRouterReasoning(item.reasoning),
	};
}

/** 解析 `GET /models` 的响应（`{data: [...]}`）为模型数组。 */
export function parseOpenRouterModels(payload: unknown): OpenRouterRemoteModel[] {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		return [];
	}
	const models: OpenRouterRemoteModel[] = [];
	for (const item of payload.data) {
		const model = parseOpenRouterModel(item);
		if (model !== undefined) {
			models.push(model);
		}
	}
	return models;
}

/** 按展示规则过滤目录（保序：沿用上游的默认排序）。 */
export function selectOpenRouterModels(
	models: readonly OpenRouterRemoteModel[],
): OpenRouterRemoteModel[] {
	return models.filter((model) => isOpenRouterDisplayModelId(model.id));
}

/**
 * 解析某模型的端点列表为**去重后**的供应商选项（保序：上游按价格升序给出）。
 *
 * ⚠️ 去重的键是 `tag` 而不是 `provider_name`：同一家可能有多个端点
 * （`baseten/fp8`、`baseten/fp8/us`、`baseten/fast`），它们是**不同的路由目标**
 * —— 只按展示名去重会静默丢掉用户真正想选的那一个。
 */
export function parseOpenRouterProviders(payload: unknown): OpenRouterProviderOption[] {
	const data = isRecord(payload) ? payload.data : undefined;
	const endpoints = isRecord(data) && Array.isArray(data.endpoints) ? data.endpoints : [];
	const entries: Array<{ slug: string; name: string }> = [];
	const seen = new Set<string>();
	for (const endpoint of endpoints) {
		if (!isRecord(endpoint)) {
			continue;
		}
		const slug = typeof endpoint.tag === 'string' ? endpoint.tag : '';
		if (slug.length === 0 || seen.has(slug)) {
			continue;
		}
		seen.add(slug);
		entries.push({
			slug,
			name: typeof endpoint.provider_name === 'string' && endpoint.provider_name.length > 0
				? endpoint.provider_name
				: slug,
		});
	}
	const duplicated = new Set<string>();
	const counts = new Map<string, number>();
	for (const entry of entries) {
		counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
	}
	for (const [name, count] of counts) {
		if (count > 1) {
			duplicated.add(name);
		}
	}
	return entries.map((entry) => ({
		slug: entry.slug,
		label: duplicated.has(entry.name) ? `${entry.name} · ${entry.slug}` : entry.name,
	}));
}

/**
 * 该模型可选的思考档位，**已按弱 → 强重排**（空数组 = 不声明选择器）。
 *
 * ⚠️ 上游 `supported_efforts` 是**降序**（最强在前，官方文档原话
 * "returned in descending effort order (highest first)"），而本仓库的选择器
 * 一律按**弱 → 强**展示（与 `codebuddy-provider.ts` 的 `CODEBUDDY_EFFORTS` 一致）。
 * 不重排会让下拉列表「上强下弱」，与另外三个 provider 相反。
 *
 * ⚠️ **不再自己补 `none`**：档位是**逐字契约**，上游只认它列出的值
 * （官方文档明确某些模型「`none` is rejected」）。要「关闭思考」只能依赖
 * 上游真的把 `none` 列进 `supported_efforts`。
 */
export function openRouterEffortsOf(
	reasoning: OpenRouterReasoning | undefined,
): readonly string[] {
	const efforts = reasoning?.supportedEfforts;
	if (!Array.isArray(efforts) || efforts.length === 0) {
		return [];
	}
	return [...efforts].reverse();
}

/** 从候选档位里挑默认档（全部未命中时取**最强**档，与另外三家一致）。 */
export function openRouterDefaultEffort(
	reasoning: OpenRouterReasoning | undefined,
	efforts: readonly string[],
): string | undefined {
	if (efforts.length === 0) {
		return undefined;
	}
	const declared = reasoning?.defaultEffort;
	if (declared !== undefined && declared.length > 0 && efforts.includes(declared)) {
		return declared;
	}
	// 上游说「默认不开思考」时，优先落在 `none`（前提是该模型确实允许 `none`）。
	if (reasoning?.defaultEnabled === false && efforts.includes('none')) {
		return 'none';
	}
	// ⚠️ 不能写 `efforts[0]` —— `efforts` 是**弱 → 强**排列，末位才是最强档。
	return efforts[efforts.length - 1];
}

/**
 * 把用户选中的档位翻译成请求体的 `reasoning` 字段。
 *
 * ⚠️ 发送前**必须再校验一次**：用户的选择可能来自缓存的旧目录，
 * 发上游不认的档位会被以非法参数拒（400）。不成立就当作没选（不下发）。
 */
export function openRouterReasoningField(
	selected: unknown,
	efforts: readonly string[],
): { effort: string } | undefined {
	if (typeof selected !== 'string' || selected.length === 0 || !efforts.includes(selected)) {
		return undefined;
	}
	return { effort: selected };
}

/**
 * 把用户选中的上游供应商翻译成请求体的 `provider` 字段。
 *
 * 语义是用户明确选定的「**严格只用它**」：`order` 指定候选，同时**关掉回退**
 * （`allow_fallbacks: false`）—— 否则该家不可用时会静默换到别家，正是用户要避免的。
 * 代价是它故障时本轮请求直接失败（错误文案里会说明这一点，见 `openRouterHttpErrorText`）。
 *
 * ⚠️ 「自动」或未选/选了目录里没有的 slug ⇒ 返回 undefined（不下发 `provider`）。
 */
export function openRouterProviderField(
	selected: unknown,
	options: readonly OpenRouterProviderOption[],
): { order: string[]; allow_fallbacks: boolean } | undefined {
	if (typeof selected !== 'string' || selected.length === 0 || selected === OPENROUTER_PROVIDER_AUTO) {
		return undefined;
	}
	if (!options.some((option) => option.slug === selected)) {
		return undefined;
	}
	return { order: [selected], allow_fallbacks: false };
}

/** 401 / 403 视为「API Key 无效」（需要用户动手修，不是瞬时故障）。 */
export function isOpenRouterAuthStatus(status: number): boolean {
	return status === 401 || status === 403;
}

/**
 * 构造 HTTP 失败时的错误文案。
 *
 * ⚠️ **必须带出上游原文**：OpenRouter 的错误体（`{"error":{"code":…,"message":…}}`）
 * 是唯一的排障线索，吞掉它就只剩一个状态码。
 *
 * ⚠️ 锁定上游且拿到 404 / 503 时补一句人话：这是「严格锁定」的**预期代价**
 * （该家当前无可用端点），否则用户会以为是插件坏了。其它状态码不加这句
 * —— 400 是参数问题，与供应商是否可用无关，乱加会把人引到错方向。
 */
export function openRouterHttpErrorText(
	status: number,
	bodyText: string,
	pinnedSlug: string | undefined,
): string {
	const detail = bodyText.trim().length > 0 ? bodyText.slice(0, 1000) : '(无响应体)';
	const base = `OpenRouter HTTP ${status}: ${detail}`;
	if (pinnedSlug !== undefined && (status === 404 || status === 503)) {
		return `${base}；已按你的选择锁定上游供应商「${pinnedSlug}」并关闭回退，它当前没有可用端点。`
			+ '可在模型选择器里把「上游供应商」改回「自动」。';
	}
	return base;
}

/** 解析 `GET /key` 的响应。 */
export function parseOpenRouterKeyInfo(payload: unknown): { label?: string } {
	const data = isRecord(payload) ? payload.data : undefined;
	const label = isRecord(data) && typeof data.label === 'string' && data.label.length > 0
		? data.label
		: undefined;
	return label === undefined ? {} : { label };
}

/**
 * API Key 的形状校验（**本地**，不发网络请求）。
 *
 * ⚠️ 只做「像个 token」的判断（长度 + 无空白），**不硬编码前缀**：
 * OpenRouter 的 key 形如 `sk-or-v1-…`，但前缀属实现细节，写死会在这类
 * 规则变动时把合法 key 挡在门外。
 */
export function isOpenRouterKeyShape(value: string): boolean {
	const trimmed = value.trim();
	return trimmed.length >= 20 && !/\s/.test(trimmed);
}

/**
 * 从 SSE delta 里取思考文本（纯函数，与 `parseTraeSSELine` 同在协议模块）。
 *
 * ⚠️ 优先取**字符串**字段 `reasoning`（`reasoning_content` 是它的别名），
 * 为空才回落到结构化的 `reasoning_details[]` —— 同一帧里两者常同时出现，
 * 都取会让思考内容被重复上报一遍。
 *
 * ⚠️ `reasoning_details` 里 `reasoning.encrypted` 只有密文（**不渲染**，
 * 当成思考显示会把一坨 base64 塞给用户）、`reasoning.summary` 是摘要、
 * `reasoning.text` 是正文。
 */
export function openRouterThinkingText(delta: Record<string, unknown>): string {
	for (const key of ['reasoning', 'reasoning_content']) {
		const value = delta[key];
		if (typeof value === 'string' && value.length > 0) {
			return value;
		}
	}
	const details = delta.reasoning_details;
	if (!Array.isArray(details)) {
		return '';
	}
	let text = '';
	for (const detail of details) {
		if (!isRecord(detail)) {
			continue;
		}
		if (typeof detail.text === 'string') {
			text += detail.text;
		} else if (typeof detail.summary === 'string') {
			text += detail.summary;
		}
	}
	return text;
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function arrayOfStrings(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseOpenRouterReasoning(value: unknown): OpenRouterReasoning | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const supported = Array.isArray(value.supported_efforts)
		? value.supported_efforts.filter((item): item is string => typeof item === 'string')
		: undefined;
	return {
		mandatory: value.mandatory === true,
		...(supported === undefined ? {} : { supportedEfforts: supported }),
		...(typeof value.default_effort === 'string' && value.default_effort.length > 0
			? { defaultEffort: value.default_effort }
			: {}),
		...(typeof value.default_enabled === 'boolean' ? { defaultEnabled: value.default_enabled } : {}),
	};
}
