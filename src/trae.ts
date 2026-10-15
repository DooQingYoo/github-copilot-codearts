// TRAE（字节跳动 TRAE IDE）协议常量、凭据结构与纯函数。
//
// 移植自 `deepseek-harness-codearts/src/trae.ts`（该仓库的 TRAE 实现已由多轮
// 实机验证），但**只取「协议 + 推理」部分**：本扩展是单凭据、只做推理，
// 不含账号池 / 积分签到 / 限流切号（与 Qoder 中国版的移植口径一致）。
//
// ## 协议速览
//
// | 用途 | 方法 | 路径 | Host | 认证 |
// |------|------|------|------|------|
// | 对话 | POST | `/api/agent/v3/llm_utils_chat` | trae-api-cn.mchost.guru | Cloud-IDE-JWT |
// | 模型列表 | POST | `/api/ide/v1/batch_get_detail_param` | (同上) | Cloud-IDE-JWT |
// | 换 token | POST | `/cloudide/api/v3/trae/oauth/ExchangeToken` | api.trae.com.cn | 无（用 refreshToken） |
// | 用户信息 | POST | `/cloudide/api/v3/trae/GetUserInfo` | (同上) | Cloud-IDE-JWT |
//
// ⚠️ chat 端点返回**自定义 SSE 事件格式**（非 OpenAI 标准），需独立解析。
//
// ## 与其它 provider 的关键差异
//
// - **凭据带机器指纹**：`machine_id` / `device_id` 必须持久化，每次对话请求必须携带。
// - **载荷必须转换**：OpenAI 的 `{model, messages, tools, tool_choice, stream}` 需要
//   映射为 SOLO 格式（`function` / `config_name` 等字段），不能透传。
// - **模型只在列出它的通道里可调用**：发错 `function` 会得到流内 `4001`。

import { createHash, randomBytes } from 'node:crypto';

// ── 端点路径 ──

/** 对话端点（SOLO 自定义 SSE）。 */
export const TRAE_CHAT_PATH = '/api/agent/v3/llm_utils_chat';
/** 模型列表（**多通道**，真实 CN IDE 用的端点）。 */
export const TRAE_BATCH_MODELS_PATH = '/api/ide/v1/batch_get_detail_param';
/** ExchangeToken（refreshToken 换 accessToken）。 */
export const TRAE_EXCHANGE_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken';
/** 用户信息。 */
export const TRAE_USER_INFO_PATH = '/cloudide/api/v3/trae/GetUserInfo';
/** 登录回调路径（TRAE 登录页强制回传）。 */
export const TRAE_CALLBACK_PATH = '/authorize';

/** 控制面请求超时（毫秒）；对话流式请求不适用。 */
export const TRAE_REQUEST_TIMEOUT_MS = 30_000;
/** 登录流程总超时（毫秒）。 */
export const TRAE_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

// ── 上游基址 ──

/** 上游 API 基址（Agent 服务：对话 + 模型列表）。 */
export const TRAE_AGENT_HOST = 'https://trae-api-cn.mchost.guru';
/** OAuth/认证基址（ExchangeToken / GetUserInfo）。 */
export const TRAE_OAUTH_HOST = 'https://api.trae.com.cn';
/** 登录门户基址。 */
export const TRAE_CONSOLE_HOST = 'https://www.trae.cn';

// ── 客户端常量 ──

/**
 * OAuth client id。
 *
 * ⚠️ 与 `pluginVersion` 是两个独立字段：前者是登录门户认的插件版本，
 * 后者是 chat 端点的模型准入版本。
 */
export const TRAE_CLIENT_ID = 'en1oxy7wnw8j9n';
/** App ID（请求头 `X-App-Id`）。 */
export const TRAE_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
/**
 * IDE 版本号（**模型可用性的准入条件**）。
 *
 * 上游按 `X-Ide-Version` / `X-App-Version-Code` 决定哪些模型可以返回，
 * 版本过低时 glm-5.3 等新模型会报 `4001 param is invalid`。
 */
export const TRAE_IDE_VERSION = '0.1.52';
/** IDE 版本号代码（日期式）。 */
export const TRAE_IDE_VERSION_CODE = '20260811';
/** 登录 URL 的 `plugin_version` 参数（**不是** IDE 版本号）。 */
export const TRAE_PLUGIN_VERSION = '2.3.62834';
/** 设备品牌（请求头 `X-Device-Brand`）。 */
export const TRAE_DEVICE_BRAND = 'Apple';
/** 操作系统版本（请求头 `X-OS-Version`）。 */
export const TRAE_OS_VERSION = 'macOS 15.7.4';
/** User-Agent。 */
export const TRAE_USER_AGENT = 'Trae/0.1.52';
/** 默认凭据 ref（单凭据模式）。 */
export const TRAE_DEFAULT_CREDENTIAL_REF = 'TRAE_ACCESS_TOKEN';

/**
 * **默认**对话通道（`function`），模型未标明所属通道时使用。
 *
 * ⚠️ 它不是「唯一的通道」——各通道模型集不同，真正的通道归属由远端目录
 * 的每条 `function` 决定（见 {@link TRAE_CHANNELS}）。
 */
export const TRAE_FUNCTION = 'solo_work_lite';

/** 默认 model（`config_name`）。 */
export const TRAE_DEFAULT_MODEL = 'glm-5.2';

/**
 * **可调用通道白名单**，**顺序即优先级**。
 *
 * ## ⚠️ 本表是白名单，不只是排序表
 *
 * 上游 `batch_get_detail_param` 会下发 22 个 function，每个 function 各自一套
 * 模型目录；但**只有一部分**在本插件的推理端点（`llm_utils_chat`）下真正可调用。
 * 逐通道实测（2026-10-04，真实凭据，每个 function 各发一次最小请求）：
 *
 * | 结果 | function |
 * |---|---|
 * | ✅ 可调用（**本表内容，15 个**） | `solo_agent` / `solo_work_lite` / `solo_agent_remote` / `solo_work_remote` / `solo_agent_lite` / `solo_design_lite` / `solo_design_remote` / `solo_coder` / `chat_v3` / `builder_v3` / `git_ai` / `code_reviewer` / `code_review_summary` / `multimodal` / `system_diagnosis` |
 * | ❌ 稳定被拒 | `chat`（`4023 the model is unknown`）/ `builder`（`4001 param is invalid`）/ `inline_chat`（`3003 model service is unavailable`） |
 * | ⚪️ 目录恒空 | `ui_builder_v2` / `solo_builder` / `custom_agent_generation` / `utils` |
 *
 * 若让解析器「目录声明了什么通道就照着发什么通道」，38 条目录里会有约一半
 * 带着不可调用的 `function`，用户一选中就稳定失败 —— 而报错文案指向**模型**，
 * 极易误判成「这个模型坏了」。
 *
 * ⚠️ **顺序即优先级**：同一模型被多个白名单通道列出时取更靠前者。
 * `solo_agent` 排首位是对齐官方 Auto Mode 选择器。
 */
export const TRAE_CHANNELS: readonly string[] = [
	// ── 通用通道（顺序即优先级）──
	'solo_agent',
	'solo_work_lite',
	'solo_agent_remote',
	'solo_work_remote',
	'solo_agent_lite',
	// ── 专用通道（只有通用通道都不含某模型时才会命中）──
	'chat_v3',
	'builder_v3',
	'solo_coder',
	'solo_design_lite',
	'solo_design_remote',
	'git_ai',
	'code_reviewer',
	'code_review_summary',
	'multimodal',
	'system_diagnosis',
];

/**
 * `batch_get_detail_param` 请求体里要查的 function 列表。
 *
 * 对齐真实 CN IDE（Trae CN.exe 3.3.94）：它传的是**全部 22 个** function，
 * 而不是只传几个聊天通道 —— 只传聊天通道会让非聊天通道的条目在响应里
 * 位置错乱。解析时只消费 {@link TRAE_CHANNELS} 白名单内的那几条。
 */
export const TRAE_QUERY_FUNCTIONS: readonly string[] = [
	'ui_builder_v2', 'solo_coder', 'chat_v3', 'solo_builder',
	'builder_v3', 'builder', 'chat', 'inline_chat', 'git_ai',
	'custom_agent_generation', 'utils', 'code_reviewer',
	'code_review_summary', 'solo_agent', 'solo_agent_remote',
	'solo_work_remote', 'solo_agent_lite', 'solo_work_lite',
	'solo_design_lite', 'solo_design_remote', 'multimodal',
	'system_diagnosis',
];

// ── 凭据结构 ──

/**
 * 持久化的 TRAE 凭据。
 *
 * ## 关键持久化字段
 *
 * - `machine_id`：32 位 hex 字符串（设备指纹），登录时生成，**不可每次重新生成**。
 * - `device_id`：32 位 hex 字符串，登录时生成，每个账号必须互不相同。
 * - `refresh_token`：ExchangeToken 每次返回会轮换，续期后必须回写。
 */
export interface TraeCredential {
	/** 访问令牌（`Authorization: Cloud-IDE-JWT <access_token>`）。 */
	access_token: string;
	/** 刷新令牌（ExchangeToken 轮换，续期后必须回写）。 */
	refresh_token: string;
	/** 过期时间（**毫秒时间戳字符串**）。 */
	expires_at?: string;
	/** 用户唯一 ID。 */
	uid: string;
	/** 昵称（UI 展示）。 */
	nickname?: string;
	/**
	 * **脱敏手机号**（`GetUserInfo` 的 `NonPlainTextMobile`，形如 `130******00`）。
	 *
	 * `ScreenName` 是字节 passport **按 uid 自动生成的默认名**（实测四个账号
	 * 全是 `用户26815487395` 这种），多账号时彼此几乎无法区分；而脱敏手机号
	 * 实测末两位互不相同，足以区分账号。
	 */
	phone?: string;
	/** **脱敏邮箱**（`GetUserInfo` 的 `NonPlainTextEmail`）；短信登录的账号为空。 */
	email?: string;
	/** 设备指纹（32 hex 字符）。**不可每次重新生成**。 */
	machine_id: string;
	/** 设备号（32 hex 字符）。每个账号必须互不相同。 */
	device_id: string;
	/** 域名（如 `trae.cn`）。 */
	domain?: string;
	/** API Host（ExchangeToken 的基址）。 */
	api_host?: string;
	/** 企业 ID。 */
	enterprise_id?: string;
}

// ── 过期时间与可刷新判定 ──

/**
 * 从 JWT 的 payload 读取 `exp`（秒）并换算为毫秒；非 JWT 或解析失败返回 undefined。
 *
 * 仅做 base64url 解码，不验签 —— 该值只用于展示与续期调度。
 */
export function jwtExpiresAtMs(token: string): number | undefined {
	if (typeof token !== 'string' || token.length === 0) {return undefined;}
	const parts = token.split('.');
	if (parts.length < 2) {return undefined;}
	try {
		const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
		return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 从凭据的 `expires_at` 解析毫秒时间戳。
 *
 * 兼容毫秒时间戳 / 秒级时间戳 / ISO 8601 三种形态。后备来源：`expires_at`
 * 为空时回退解析 `access_token` 这个 JWT 的 `exp`。
 */
export function traeCredentialExpiresAtMs(credential: TraeCredential): number | undefined {
	const raw = credential.expires_at;
	if (typeof raw === 'string' && raw.length > 0) {
		if (/^\d+$/.test(raw)) {
			const value = Number(raw);
			return value > 1_000_000_000_000 ? value : value * 1000;
		}
		const parsed = Date.parse(raw);
		if (!Number.isNaN(parsed)) {return parsed;}
	}
	return jwtExpiresAtMs(credential.access_token);
}

/** 凭据是否已过期；无法解析过期时间时**不**判定过期。 */
export function isTraeExpired(credential: TraeCredential): boolean {
	const expiresAt = traeCredentialExpiresAtMs(credential);
	return expiresAt === undefined ? false : Date.now() >= expiresAt;
}

/** 凭据是否携带可静默续期的 refresh_token。 */
export function isTraeRefreshable(credential: TraeCredential): boolean {
	return typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0;
}

// ── 请求头构造 ──

/**
 * 构造 SOLO 对话/模型列表请求头。
 *
 * ⚠️ 有多处设置相同的 token 值（`Authorization` / `X-Cloudide-Token` /
 * `X-Ide-Token`），实测缺任一个都可能被上游拒绝。
 */
export function traeSOLOHeaders(credential: TraeCredential, stream: boolean): Record<string, string> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Accept: stream ? 'text/event-stream' : 'application/json',
		'User-Agent': TRAE_USER_AGENT,
		Authorization: `Cloud-IDE-JWT ${credential.access_token}`,
		'X-Cloudide-Token': credential.access_token,
		'X-Ide-Token': credential.access_token,
		'X-Uid': credential.uid,
		'X-App-Id': TRAE_APP_ID,
		'X-App-Version': 'default',
		'X-Ide-Version': TRAE_IDE_VERSION,
		'X-Ide-Version-Code': TRAE_IDE_VERSION_CODE,
		'X-App-Version-Code': TRAE_IDE_VERSION_CODE,
		'X-Ide-Version-Type': 'stable',
		'X-Device-Type': 'macos',
		'X-OS-Version': TRAE_OS_VERSION,
		'X-Device-Brand': TRAE_DEVICE_BRAND,
		'Request-Traffic-Type': 'prod',
	};
	if (credential.machine_id.length > 0) {headers['X-Machine-Id'] = credential.machine_id;}
	if (credential.device_id.length > 0) {headers['X-Device-Id'] = credential.device_id;}
	return headers;
}

/**
 * 构造 OAuth（ExchangeToken / GetUserInfo）请求头：无签名，仅 UA。
 *
 * `GetUserInfo` 需要额外 `X-Cloudide-Token` 头，由调用方自行添加。
 */
export function traeOAuthHeaders(): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		Accept: 'application/json',
		'User-Agent': TRAE_USER_AGENT,
	};
}

// ── ExchangeToken / GetUserInfo 响应解析 ──

/** ExchangeToken 响应体的 Result 部分。 */
export interface TraeExchangeResult {
	accessToken: string;
	refreshToken: string;
	/** 过期时间（绝对值，秒或毫秒，由上游决定）。 */
	tokenExpireAt: number;
	/** 相对过期秒数。 */
	tokenExpireDuration: number;
	/** refresh_token 过期时间。 */
	refreshExpireAt: number;
}

/** 从 JSON 安全读取字符串字段（兼容后端把数字返回成 number）。 */
export function readStringField(source: Record<string, unknown>, key: string): string {
	const value = source[key];
	if (typeof value === 'string') {return value;}
	if (typeof value === 'number' && Number.isFinite(value)) {return String(value);}
	return '';
}

/** 从 JSON 安全读取数字字段（兼容字符串形态的数字）。 */
export function readNumberField(source: Record<string, unknown>, key: string): number | undefined {
	const value = source[key];
	if (typeof value === 'number' && Number.isFinite(value)) {return value;}
	if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {return Number(value);}
	return undefined;
}

/**
 * 从 JSON 安全读取布尔字段。
 *
 * 只有**明确**的布尔语义才返回值：字段缺失返回 `undefined`（「上游没说」与
 * 「上游说 false」是两回事，调用方据此决定是否过滤）。
 */
export function readBooleanField(source: Record<string, unknown>, key: string): boolean | undefined {
	const value = source[key];
	if (typeof value === 'boolean') {return value;}
	if (value === 1 || value === 'true') {return true;}
	if (value === 0 || value === 'false') {return false;}
	return undefined;
}

/**
 * 解析 ExchangeToken 响应。
 *
 * 响应结构：`{ Result: { Token, TokenExpireAt, TokenExpireDuration, RefreshToken, RefreshExpireAt } }`
 */
export function parseTraeExchangeResponse(data: Record<string, unknown>): TraeExchangeResult | undefined {
	const result = data.Result ?? data.result;
	if (typeof result !== 'object' || result === null) {return undefined;}
	const r = result as Record<string, unknown>;
	const accessToken = readStringField(r, 'Token') || readStringField(r, 'token') || readStringField(r, 'accessToken');
	const refreshToken = readStringField(r, 'RefreshToken') || readStringField(r, 'refreshToken');
	if (accessToken.length === 0) {return undefined;}
	return {
		accessToken,
		refreshToken,
		tokenExpireAt: readNumberField(r, 'TokenExpireAt') ?? readNumberField(r, 'tokenExpireAt') ?? 0,
		tokenExpireDuration: readNumberField(r, 'TokenExpireDuration') ?? readNumberField(r, 'tokenExpireDuration') ?? 0,
		refreshExpireAt: readNumberField(r, 'RefreshExpireAt') ?? readNumberField(r, 'refreshExpireAt') ?? 0,
	};
}

/** GetUserInfo 响应体的 Result 部分。 */
export interface TraeUserInfoResult {
	uid: string;
	screenName: string;
	enterpriseId: string;
	/** 脱敏手机号（`NonPlainTextMobile`）；无则空串。 */
	phone: string;
	/** 脱敏邮箱（`NonPlainTextEmail`）；短信登录的账号为空串。 */
	email: string;
}

/**
 * 解析 GetUserInfo 响应。
 *
 * ⚠️ 字段名是 **`NonPlainTextMobile` / `NonPlainTextEmail`**（不是 `Mobile` /
 * `Phone` / `Email`）—— 实测 `GetUserInfo` 只下发这两个脱敏形态。
 */
export function parseTraeUserInfoResponse(data: Record<string, unknown>): TraeUserInfoResult | undefined {
	const result = data.Result ?? data.result;
	if (typeof result !== 'object' || result === null) {return undefined;}
	const r = result as Record<string, unknown>;
	const uid = readStringField(r, 'UserID') || readStringField(r, 'userId') || readStringField(r, 'uid');
	if (uid.length === 0) {return undefined;}
	return {
		uid,
		screenName: readStringField(r, 'ScreenName') || readStringField(r, 'screenName') || uid,
		enterpriseId: readStringField(r, 'EnterpriseID') || readStringField(r, 'enterpriseId') || '',
		phone: readStringField(r, 'NonPlainTextMobile') || readStringField(r, 'nonPlainTextMobile'),
		email: readStringField(r, 'NonPlainTextEmail') || readStringField(r, 'nonPlainTextEmail'),
	};
}

/**
 * 由 ExchangeToken 结果 + 用户信息组装凭据。
 *
 * `expires_at` 取值顺序：
 * 1. `tokenExpireAt`（绝对值，> 1e12 视为毫秒，否则视为秒）；
 * 2. `tokenExpireDuration`（相对秒数，以当前时刻为基准）；
 * 3. 都拿不到则留空（由 JWT exp 兜底）。
 */
export function buildTraeCredential(
	exchange: TraeExchangeResult,
	userInfo: TraeUserInfoResult,
	session: { machineId: string; deviceId: string },
	nowMs: number = Date.now(),
): TraeCredential {
	const expiresAt = resolveExpiresAt(exchange, nowMs);
	return {
		access_token: exchange.accessToken,
		refresh_token: exchange.refreshToken,
		expires_at: expiresAt,
		uid: userInfo.uid,
		nickname: userInfo.screenName,
		...userInfo.phone.length > 0 ? { phone: userInfo.phone } : {},
		...userInfo.email.length > 0 ? { email: userInfo.email } : {},
		machine_id: session.machineId,
		device_id: session.deviceId,
		enterprise_id: userInfo.enterpriseId,
	};
}

/** 由 ExchangeToken 结果推算 `expires_at`（毫秒字符串）；拿不到时返回空串。 */
function resolveExpiresAt(exchange: TraeExchangeResult, nowMs: number): string {
	if (exchange.tokenExpireAt > 1e12) {return String(exchange.tokenExpireAt);}
	if (exchange.tokenExpireAt > 0) {return String(exchange.tokenExpireAt * 1000);}
	if (exchange.tokenExpireDuration > 0) {return String(nowMs + exchange.tokenExpireDuration * 1000);}
	const exp = jwtExpiresAtMs(exchange.accessToken);
	return exp === undefined ? '' : String(exp);
}

/**
 * 用续期结果更新凭据。
 *
 * ExchangeToken 响应会轮换 access_token 和 refresh_token。
 * 保留所有身份字段（machine_id / device_id / uid / nickname / enterprise_id）。
 */
export function applyTraeRefresh(
	previous: TraeCredential,
	exchange: TraeExchangeResult,
	nowMs: number = Date.now(),
): TraeCredential {
	return {
		...previous,
		access_token: exchange.accessToken,
		// refresh_token 也会被轮换，新值不为空时才更新。
		refresh_token: exchange.refreshToken.length > 0 ? exchange.refreshToken : previous.refresh_token,
		expires_at: resolveExpiresAt(exchange, nowMs),
	};
}

/**
 * 构造 TRAE 账号的**展示名**：手机号优先，缺失时回退 ScreenName。
 *
 * `ScreenName` 是字节 passport **按 uid 自动生成的默认名**（`用户26815487395`
 * 这种），一屏列出来根本认不出谁是谁。可用字段实测：
 *
 * | 字段 | 值 | 可区分性 |
 * |---|---|---|
 * | `ScreenName` | `用户26815487395` 等 | ❌ 自动生成，形态雷同 |
 * | `NonPlainTextMobile` | `130******00` | ✅ 末两位互异 |
 * | `NonPlainTextEmail` | 短信登录时全为空 | ❌ |
 *
 * ⚠️ 手机号与邮箱都是**脱敏**形态，照原样展示即可，不要试图还原。
 */
export function traeDisplayNickname(
	credential: Pick<TraeCredential, 'phone' | 'email' | 'nickname' | 'uid'> | undefined,
	fallbackId: string,
): string {
	const phone = typeof credential?.phone === 'string' ? credential.phone.trim() : '';
	if (phone.length > 0) {return phone;}
	const email = typeof credential?.email === 'string' ? credential.email.trim() : '';
	if (email.length > 0) {return email;}
	const nickname = typeof credential?.nickname === 'string' ? credential.nickname.trim() : '';
	if (nickname.length > 0) {return nickname;}
	const uid = typeof credential?.uid === 'string' ? credential.uid.trim() : '';
	return uid.length > 0 ? uid : fallbackId;
}

/** 把脱敏手机号 / 邮箱写进凭据（返回新对象，不改原凭据）。 */
export function withTraePhone(
	credential: TraeCredential,
	phone: string | undefined,
	email?: string | undefined,
): TraeCredential {
	const hasPhone = phone !== undefined && phone.length > 0;
	const hasEmail = email !== undefined && email.length > 0;
	if (!hasPhone && !hasEmail) {return credential;}
	return {
		...credential,
		...hasPhone ? { phone } : {},
		...hasEmail ? { email } : {},
	};
}

// ── 身份 ID 生成 ──

/**
 * 生成 32 位 hex 字符的 `machine_id`（16 字节）。
 *
 * 登录时生成并持久化，**不可每次重新生成** —— 上游按 `machine_id` 标识设备。
 */
export function generateMachineId(): string {
	return randomBytes(16).toString('hex');
}

/**
 * 生成 32 位 hex 字符的 `device_id`。
 *
 * ⚠️ 是 **hex32**（`openssl rand -hex 16` 的产物），不是「16 位纯数字」
 * （那是 CodeBuddy 的签到设备号格式）。该值会随登录 URL 的 `device_id` /
 * `x_device_id` 一起下发，也会写进凭据并用于请求的 `X-Device-Id` 头。
 */
export function generateDeviceId(): string {
	return randomBytes(16).toString('hex');
}

/**
 * 由 machineId + deviceId 派生稳定的 `login_trace_id`（hex16）。
 *
 * 取拼接串的**尾部 16 字符**。作用是让回调能被关联回本次登录的 pending
 * （TRAE 回调不保证回传 machine_id/device_id，但会回传 login_trace_id）。
 */
export function machineTraceId(machineId: string, deviceId: string): string {
	const joined = machineId + deviceId;
	return joined.length >= 16 ? joined.slice(-16) : joined.padStart(16, '0');
}

// ── 模型列表解析 ──

/** TRAE 远端模型条目。 */
export interface TraeRemoteModel {
	id: string;
	name: string;
	/** 上下文窗口（`maxInputTokens`），取自 `context_window_tokens.dev`。 */
	contextWindow?: number;
	/** 输出上限，取自 `model_detail_list[].max_tokens`。 */
	maxOutputTokens?: number;
	/**
	 * `display_config.is_custom_model` —— 该条目是**需用户自行配置的自定义模型**
	 * （在 TRAE IDE 内绑定真实供应商后才可用）。
	 *
	 * ⚠️ 实测该标志为 `true` 的条目全部被上游以流内 `event:error` 拒绝
	 * （`code=4001`），是「**仅可见但不可调用**」的权威判据。
	 * ⚠️ 该标志会随服务端下发变化，**不要把某一刻的条目名写进代码或断言**。
	 */
	isCustomModel?: boolean;
	/** 提供该模型的聊天通道（`function`）。 */
	function?: string;
	/** `is_invisible_to_user` —— 上游标记的内部/隐藏条目。 */
	isHidden?: boolean;
	/** `config_switch` —— 上游是否启用该条目；`false` 表示已停用。 */
	isEnabled?: boolean;
	/** 消耗倍率（`display_contact_config.consumption_rate.data.rate`）。 */
	creditsRate?: number;
	/** 活动折扣的原价。 */
	originalCreditsRate?: number;
	/** 活动结束时间（Unix **秒**）。 */
	discountEndsAtSec?: number;
	/** 用途（`usage`）；只有 `chat_completion` 才适合作为对话模型。 */
	usage?: string;
	/** 推理强度配置（`reasoning_effort_config`）。 */
	reasoningConfig?: TraeReasoningConfig;
	/** `display_config.multimodal` —— 该模型是否接受**用户图片**输入。 */
	multimodal?: boolean;
	/** `display_config.tool_response_multimodal` —— 工具结果内嵌图片能否回传。 */
	toolResponseMultimodal?: boolean;
	/** `display_config.max_mode` —— 该模型是否支持 **Max 模式**（1M 上下文）。 */
	maxMode?: boolean;
	/** `context_window_tokens.max` —— Max 模式下的上下文窗口。 */
	maxContextWindow?: number;
	/** `model_detail_list` 中以 `__max` 结尾那条的 `max_tokens`。 */
	maxModeOutputTokens?: number;
}

/** 推理强度配置（`reasoning_effort_config`）。 */
export interface TraeReasoningConfig {
	/** 默认档位（`default_level`），须落在 {@link options} 内才可作默认值。 */
	defaultLevel?: string;
	/** 可选档位（wire 值）。空数组表示远端未声明可用档位。 */
	options: readonly string[];
	/** `support_thinking` —— 是否支持思考。 */
	supportThinking?: boolean;
}

/**
 * 该条目是否**可调用**（硬性过滤）。
 *
 * 两个标志各自独立、都必须放行：
 * - `isCustomModel`：需用户在 IDE 内自行配置 → 必然调不通（流内 `4001`）
 * - `isEnabled === false`：上游已停用
 *
 * 未声明（`undefined`）一律**放行**：宁可多留一个模型，也不要因缺字段误删整批。
 *
 * ⚠️ `isHidden`（官方的 `is_invisible_to_user`）**不在这里判定** —— 它表示
 * 「官方客户端的选择器不展示」，与「能不能调用」是两个独立维度。
 */
export function isTraeModelCallable(model: TraeRemoteModel): boolean {
	return model.isCustomModel !== true && model.isEnabled !== false;
}

/** 读取 `context_window_tokens.dev`（缺失时回退 `max`）。 */
function readContextWindowField(entry: Record<string, unknown>): number | undefined {
	const raw = entry.context_window_tokens ?? entry.ContextWindowTokens;
	if (typeof raw !== 'object' || raw === null) {return undefined;}
	const record = raw as Record<string, unknown>;
	const value = readNumberField(record, 'dev')
		?? readNumberField(record, 'Dev')
		?? readNumberField(record, 'max')
		?? readNumberField(record, 'Max');
	return value !== undefined && value > 0 ? Math.trunc(value) : undefined;
}

/**
 * 读取 `context_window_tokens.max`（Max 模式专用窗口，通常 1000000）。
 *
 * ⚠️ 与 {@link readContextWindowField} 分开：那个取 `dev`（默认可用），
 * 本函数取 `max`（仅开 Max 模式时可用）。两者绝不能混用。
 */
function readMaxContextWindowField(entry: Record<string, unknown>): number | undefined {
	const raw = entry.context_window_tokens ?? entry.ContextWindowTokens;
	if (typeof raw !== 'object' || raw === null) {return undefined;}
	const record = raw as Record<string, unknown>;
	const value = readNumberField(record, 'max') ?? readNumberField(record, 'Max');
	return value !== undefined && value > 0 ? Math.trunc(value) : undefined;
}

/**
 * 读取 `model_detail_list[].max_tokens`。
 *
 * 多条明细时优先取 `model_name` 以 `preferredSuffix` 结尾的那条
 * （对齐上游的 `config_name__dev` / `config_name__max` 约定），否则取第一条。
 */
function readDetailMaxTokens(entry: Record<string, unknown>, preferredSuffix = '__dev'): number | undefined {
	const raw = entry.model_detail_list ?? entry.ModelDetailList;
	if (!Array.isArray(raw) || raw.length === 0) {return undefined;}
	const details = raw.filter(
		(item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
	);
	const preferred = details.find((item) => readStringField(item, 'model_name').endsWith(preferredSuffix));
	const chosen = preferred ?? details[0];
	if (chosen === undefined) {return undefined;}
	const value = readNumberField(chosen, 'max_tokens') ?? readNumberField(chosen, 'MaxTokens');
	return value !== undefined && value > 0 ? Math.trunc(value) : undefined;
}

/**
 * 读取 `reasoning_effort_config`。
 *
 * 真实形状：`{ default_level, options: ["light","high","extra_high"], support_thinking }`。
 * `options` 同时兼容**字符串数组**（实测形态）与**对象数组**（防御性兼容）。
 *
 * 一个字段都没有时返回 `undefined`（而不是空配置）：调用方据此不声明
 * `configurationSchema`，避免给用户一个发了也没用的档位选择器。
 */
function readReasoningEffortConfig(entry: Record<string, unknown>): TraeReasoningConfig | undefined {
	const raw = entry.reasoning_effort_config ?? entry.ReasoningEffortConfig;
	if (typeof raw !== 'object' || raw === null) {return undefined;}
	const record = raw as Record<string, unknown>;

	const options: string[] = [];
	const rawOptions = record.options ?? record.Options;
	if (Array.isArray(rawOptions)) {
		for (const item of rawOptions) {
			if (typeof item === 'string' && item.trim().length > 0) {
				options.push(item.trim());
			} else if (typeof item === 'object' && item !== null) {
				const obj = item as Record<string, unknown>;
				const wire = readStringField(obj, 'openclawLevel')
					|| readStringField(obj, 'level')
					|| readStringField(obj, 'Level');
				if (wire.trim().length > 0) {options.push(wire.trim());}
			}
		}
	}

	const defaultLevel = readStringField(record, 'default_level') || readStringField(record, 'DefaultLevel');
	const supportThinking = readBooleanField(record, 'support_thinking')
		?? readBooleanField(record, 'SupportThinking');

	if (options.length === 0 && defaultLevel.length === 0 && supportThinking === undefined) {return undefined;}
	return {
		options,
		...defaultLevel.length > 0 ? { defaultLevel } : {},
		...supportThinking === undefined ? {} : { supportThinking },
	};
}

/**
 * 解析 `display_contact_config` 里的**消耗倍率**。
 *
 * ## 为什么必须单独一个函数
 *
 * `display_contact_config` 是**一个 JSON 字符串**（不是对象）：
 * ```json
 * "{\"consumption_rate\":{\"enable\":true,\"data\":{\"rate\":0.08}},\"multimodal\":{...}}"
 * ```
 * 直接读 `entry.display_contact_config.consumption_rate` 永远得到 undefined。
 *
 * ## 三条判据（缺一不可）
 *
 * 1. `consumption_rate.enable !== false` —— 上游显式关闭时**不显示**，而不是当成 0；
 * 2. `data.rate` 是**有限非负数**（实测形态是裸数字 `0.08`）；
 * 3. ⚠️ **`rate: 0` 是合法值**（免费），不能用 `> 0` 过滤。
 */
export function readConsumptionRate(entry: Record<string, unknown>): number | undefined {
	const raw = entry.display_contact_config ?? entry.DisplayContactConfig;
	if (typeof raw !== 'string' || raw.length === 0) {return undefined;}
	const config = parseJsonObject(raw);
	if (config === undefined) {return undefined;}
	const rate = config.consumption_rate ?? config.ConsumptionRate;
	if (typeof rate !== 'object' || rate === null) {return undefined;}
	const rateRecord = rate as Record<string, unknown>;
	if (readBooleanField(rateRecord, 'enable') === false) {return undefined;}
	const data = rateRecord.data ?? rateRecord.Data;
	if (typeof data !== 'object' || data === null) {return undefined;}
	const value = readNumberField(data as Record<string, unknown>, 'rate');
	return value !== undefined && value >= 0 ? value : undefined;
}

/**
 * 解析 `activity_discount` —— 只在**当前确实生效**时返回原价与截止时间。
 *
 * ## 为什么不能只看 `enable: true`
 *
 * 实测陷阱：`enable` 为 `true` 但**当前并没有折扣**。`off_peak` 型条目形如
 * `{type:"none", before:0.13, after:0.13, discount:100}` —— `discount: 100`
 * 表示「无折扣」，`before === after`。若照显会显示 `x0.13→x0.13`。
 *
 * 三条判据：
 * 1. `activity_discount.enable !== false`；
 * 2. `data.current` 存在，且 `discount_type` **不是 `"none"`**；
 * 3. `before_consumption_rate` 是有限正数，且**严格大于** `after`。
 *
 * `end_at`（Unix 秒）仅 `limited` 型带；**已过期**时整个折扣视为不存在。
 */
export function readActivityDiscount(
	entry: Record<string, unknown>,
	nowSec: number = Math.floor(Date.now() / 1000),
): { originalRate: number; endsAtSec?: number } | undefined {
	const raw = entry.display_contact_config ?? entry.DisplayContactConfig;
	if (typeof raw !== 'string' || raw.length === 0) {return undefined;}
	const config = parseJsonObject(raw);
	if (config === undefined) {return undefined;}
	const discount = config.activity_discount ?? config.ActivityDiscount;
	if (typeof discount !== 'object' || discount === null) {return undefined;}
	const discountRecord = discount as Record<string, unknown>;
	if (readBooleanField(discountRecord, 'enable') === false) {return undefined;}
	const data = discountRecord.data ?? discountRecord.Data;
	if (typeof data !== 'object' || data === null) {return undefined;}
	const dataRecord = data as Record<string, unknown>;
	const current = dataRecord.current ?? dataRecord.Current;
	if (typeof current !== 'object' || current === null) {return undefined;}
	const currentRecord = current as Record<string, unknown>;
	const type = (readStringField(currentRecord, 'discount_type')
		|| readStringField(currentRecord, 'discountType')).trim().toLowerCase();
	if (type.length === 0 || type === 'none') {return undefined;}
	const before = readNumberField(currentRecord, 'before_consumption_rate')
		?? readNumberField(currentRecord, 'beforeConsumptionRate');
	const after = readNumberField(currentRecord, 'consumption_rate')
		?? readNumberField(currentRecord, 'consumptionRate');
	if (before === undefined || before <= 0) {return undefined;}
	if (after !== undefined && before <= after) {return undefined;}
	let endsAtSec: number | undefined;
	for (const value of Object.values(dataRecord)) {
		if (typeof value !== 'object' || value === null) {continue;}
		const end = readNumberField(value as Record<string, unknown>, 'end_at')
			?? readNumberField(value as Record<string, unknown>, 'endAt');
		if (end !== undefined && end > 0) {endsAtSec = end; break;}
	}
	if (endsAtSec !== undefined && endsAtSec <= nowSec) {return undefined;}
	return endsAtSec === undefined ? { originalRate: before } : { originalRate: before, endsAtSec };
}

/** 宽松解析 JSON 对象字符串；非对象（数组/标量/非法 JSON）返回 undefined。 */
function parseJsonObject(raw: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {return undefined;}
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** 解析单条 `config_info_list` 条目。 */
function parseTraeConfigEntry(
	entry: Record<string, unknown>,
	channel: string | undefined,
): TraeRemoteModel | undefined {
	const id = readStringField(entry, 'config_name') || readStringField(entry, 'ConfigName');
	if (id.length === 0) {return undefined;}
	const display = entry.display_config ?? entry.DisplayConfig;
	const displayRecord = typeof display === 'object' && display !== null
		? display as Record<string, unknown>
		: undefined;
	const name = displayRecord !== undefined ? readStringField(displayRecord, 'display_name') || id : id;
	// 所有标志「上游没说」都保持 undefined（不填 false）：过滤方只挡明确命中者。
	const isCustomModel = displayRecord === undefined
		? undefined
		: readBooleanField(displayRecord, 'is_custom_model') ?? readBooleanField(displayRecord, 'IsCustomModel');
	const isHidden = readBooleanField(entry, 'is_invisible_to_user') ?? readBooleanField(entry, 'IsInvisibleToUser');
	const isEnabled = readBooleanField(entry, 'config_switch') ?? readBooleanField(entry, 'ConfigSwitch');
	const usage = readStringField(entry, 'usage') || readStringField(entry, 'Usage');
	const contextWindow = readContextWindowField(entry);
	const maxOutputTokens = readDetailMaxTokens(entry);
	const maxMode = displayRecord === undefined
		? undefined
		: readBooleanField(displayRecord, 'max_mode') ?? readBooleanField(displayRecord, 'MaxMode');
	const maxContextWindow = readMaxContextWindowField(entry);
	const maxModeOutputTokens = readDetailMaxTokens(entry, '__max');
	const multimodal = displayRecord === undefined
		? undefined
		: readBooleanField(displayRecord, 'multimodal') ?? readBooleanField(displayRecord, 'Multimodal');
	const toolResponseMultimodal = displayRecord === undefined
		? undefined
		: readBooleanField(displayRecord, 'tool_response_multimodal')
			?? readBooleanField(displayRecord, 'ToolResponseMultimodal');
	const reasoningConfig = readReasoningEffortConfig(entry);
	const creditsRate = readConsumptionRate(entry);
	const discount = readActivityDiscount(entry);
	return {
		id,
		name,
		...channel === undefined ? {} : { function: channel },
		...isCustomModel === undefined ? {} : { isCustomModel },
		...isHidden === undefined ? {} : { isHidden },
		...isEnabled === undefined ? {} : { isEnabled },
		...usage.length > 0 ? { usage } : {},
		...reasoningConfig === undefined ? {} : { reasoningConfig },
		...maxMode === undefined ? {} : { maxMode },
		...multimodal === undefined ? {} : { multimodal },
		...toolResponseMultimodal === undefined ? {} : { toolResponseMultimodal },
		...maxContextWindow === undefined ? {} : { maxContextWindow },
		...maxModeOutputTokens === undefined ? {} : { maxModeOutputTokens },
		...contextWindow === undefined ? {} : { contextWindow },
		...maxOutputTokens === undefined ? {} : { maxOutputTokens },
		...creditsRate === undefined ? {} : { creditsRate },
		...discount === undefined ? {} : { originalCreditsRate: discount.originalRate },
		...discount?.endsAtSec === undefined ? {} : { discountEndsAtSec: discount.endsAtSec },
	};
}

/**
 * 解析 `batch_get_detail_param`（**多通道**）响应。
 *
 * 响应形如 `{ function_configs: [{ function, config_info_list: [...] }, …] }`，
 * **每个 function 各自一套模型目录**。
 *
 * 合并规则（同一个 `config_name` 出现在多个 function 中时取**一条**）：
 *
 * 1. **空档位不得覆盖有档位**：候选与已选条目各自「能否声明出思考档位」由
 *    {@link declaresReasoningOptions} 判定。已选条目有档位而候选没有时保留已选。
 * 2. **两侧都声明档位时按 `channelPriority` 取更靠前者**。
 * 3. **其余情形保持既有「后覆盖前」语义**。
 *
 * ⚠️ 原实现是**无条件「后面的覆盖前面的」**，其假设「后面的条目带着更完整的
 * 配置」**与真实数据相反**：上游把空档位的 `solo_work_lite` / `solo_design_remote`
 * 等条目排在**最后**，于是信息更全的条目被覆盖成更空的条目（实测 13 个模型
 * 因此丢掉 `reasoning_effort_config`）。
 *
 * ⚠️ **档位必须与 `function` 同源**：发档位的通道必须正是声明支持它的通道，
 * 否则上游按 `support_thinking:false` 处理。故这里整条择优，而不是把
 * `reasoningConfig` 单独搬运到另一条条目上。
 *
 * 同时四条硬性过滤在合并时执行：
 * - **`function` 不在 `channelPriority`（白名单）内**的整组跳过；
 * - `usage` 非 `chat_completion` 的排除；
 * - `config_switch === false` 排除；
 * - `is_invisible_to_user === true` 排除。
 *
 * @param channelPriority **可调用通道白名单**，下标越小优先级越高。同时承担
 *   两个职责：不在表内的通道被丢弃；同一模型被多个表内通道列出时取更靠前者。
 */
export function parseTraeBatchModelList(
	body: unknown,
	channelPriority: readonly string[] = TRAE_CHANNELS,
): TraeRemoteModel[] {
	if (typeof body !== 'object' || body === null) {return [];}
	const record = body as Record<string, unknown>;
	const groups = record.function_configs ?? record.FunctionConfigs;
	if (!Array.isArray(groups)) {return [];}

	const rankOf = (channel: string): number => channelPriority.indexOf(channel);

	const byId = new Map<string, TraeRemoteModel>();
	const chosenRank = new Map<string, number>();
	for (const group of groups) {
		if (typeof group !== 'object' || group === null) {continue;}
		const g = group as Record<string, unknown>;
		const channel = readStringField(g, 'function') || readStringField(g, 'Function');
		// ⚠️ 白名单准入：未声明的通道、以及**不在白名单内的通道**整组跳过 ——
		// 后者的模型发出去必然被上游拒（判据见 TRAE_CHANNELS 的实测表）。
		if (channel.length === 0 || rankOf(channel) < 0) {continue;}
		const list = g.config_info_list ?? g.ConfigInfoList;
		if (!Array.isArray(list)) {continue;}
		for (const item of list) {
			if (typeof item !== 'object' || item === null) {continue;}
			const model = parseTraeConfigEntry(item as Record<string, unknown>, channel);
			if (model === undefined) {continue;}
			// 三条硬性过滤（batch 端点是全功能配置表，含 summary / multimodal 等
			// 非对话用途条目，混入目录会塞满无关模型）。
			if (model.usage !== undefined && model.usage !== 'chat_completion') {continue;}
			if (model.isEnabled === false) {continue;}
			if (model.isHidden === true) {continue;}
			const incumbent = byId.get(model.id);
			if (incumbent === undefined) {
				byId.set(model.id, model);
				chosenRank.set(model.id, rankOf(channel));
				continue;
			}
			const incumbentHasEffort = declaresReasoningOptions(incumbent);
			const candidateHasEffort = declaresReasoningOptions(model);
			// 规则 1：空档位不得覆盖有档位。
			if (incumbentHasEffort && !candidateHasEffort) {continue;}
			// 规则 2：两侧都有档位时按通道优先级取更靠前者。
			if (incumbentHasEffort && candidateHasEffort) {
				if (rankOf(channel) >= (chosenRank.get(model.id) ?? 0)) {continue;}
			}
			// 规则 3：其余情形沿用既有的「后覆盖前」。
			byId.set(model.id, model);
			chosenRank.set(model.id, rankOf(channel));
		}
	}
	return [...byId.values()];
}

/**
 * 该条目**能否真正声明出思考档位**。
 *
 * 判据必须与 provider 的 `reasoningFor` 完全一致（配置存在 + 未显式
 * `support_thinking: false` + `options` 非空）。⚠️ 只判「配置存在」是不够的：
 * `{support_thinking: false, options: []}` 与 `{support_thinking: false,
 * options: ['high']}` 都「存在配置」，但前者在 provider 里仍会返回 `undefined`。
 */
export function declaresReasoningOptions(model: TraeRemoteModel): boolean {
	const config = model.reasoningConfig;
	if (config === undefined) {return false;}
	if (config.supportThinking === false) {return false;}
	return config.options.length > 0;
}

// ── Max 模式（1M 上下文）──

/** Max 模式的上下文窗口默认值（1M）。 */
export const TRAE_MAX_CONTEXT_TOKENS = 1_000_000;
/** Max 模式的提示词预算（936K）。 */
export const TRAE_MAX_PROMPT_TOKENS = 936_000;
/** Max 模式的输出上限（64K）。 */
export const TRAE_MAX_OUTPUT_TOKENS = 64_000;
/** Max 模式的 `mode_type` 取值。 */
export const TRAE_MAX_MODE_TYPE = 1;

/**
 * 构造把远程会话钉到 **Max 模式**（1M 上下文）的 wire 字段。
 *
 * 实测要点：
 * - ⚠️ **不能只调大 `max_tokens`**：上游按 `strategy=max` +
 *   `model_auto_selection.strategy=max` 判定「这是一个 Max 会话」，缺了它们
 *   只会被当成普通会话、按 200K 校验，然后拒绝 1M 的输入。
 * - `context_window_size` / `prompt_max_tokens` / `max_tokens` 三者要**成套**下发。
 * - 只有远端明确标了 `display_config.max_mode === true` 的模型才能用。
 */
export function traeMaxModeFields(maxContext: number, outputMax?: number): Record<string, unknown> {
	const context = maxContext > 0 ? maxContext : TRAE_MAX_CONTEXT_TOKENS;
	return {
		model_auto_selection: {
			strategy: 'max',
			fallback_to_advance_model: null,
			entitlement_id: null,
		},
		model_selection_strategy: 'max',
		mode_type: TRAE_MAX_MODE_TYPE,
		context_window_size: context,
		prompt_max_tokens: TRAE_MAX_PROMPT_TOKENS,
		max_tokens: outputMax !== undefined && outputMax > 0 ? outputMax : TRAE_MAX_OUTPUT_TOKENS,
	};
}

/**
 * 单次请求输出额度的**安全上限**。
 *
 * 参考实现实测结论：Trae SOLO CN 的 agent-remote 模型单次响应上限为
 * **64000 tokens**，客户端索要 131072 会把上游直接打成 4xx。
 */
export const TRAE_DEFAULT_MAX_COMPLETION_TOKENS = 64_000;

/** 把请求的输出额度收敛到安全上限。只收敛**正整数**。 */
export function clampTraeMaxTokens(
	value: number | undefined,
	limit: number = TRAE_DEFAULT_MAX_COMPLETION_TOKENS,
): number | undefined {
	if (value === undefined || !Number.isFinite(value) || value <= 0) {return value;}
	if (limit <= 0) {return value;}
	return Math.min(value, limit);
}

// ── OpenAI → SOLO 载荷转换 ──

/**
 * 将 OpenAI 格式的请求体转换为 SOLO 格式。
 *
 * 改写规则：
 * 1. `messages.content` 字符串 → `[{type:"text",text:...}]`；已经是数组 → 透传
 * 2. `stream`: 强制 true
 * 3. `model` → `config_name` + `model`（双字段）
 * 4. `function`: 取 `channel`，缺省 `solo_work_lite`
 * 5. `tools` / `tool_choice`: 归一化（`"none"` 删 tools；`auto`/`required` 保留；
 *    `function` 提取 name）
 * 6. assistant 消息中的 `tool_calls`: `function` → `function_call`（SOLO 字段名）
 * 7. `tools` 的 `parameters`: object → JSON string（SOLO 要求）
 *
 * @param openaiBody 原始的 OpenAI 请求体
 * @param channel 聊天通道（`function`）。**同一模型只在列出它的通道里可调用**。
 */
export function transformToSOLOBody(
	openaiBody: Record<string, unknown>,
	channel?: string,
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		...openaiBody,
		stream: true,
		function: channel !== undefined && channel.length > 0 ? channel : TRAE_FUNCTION,
	};

	const msgs = body.messages;
	if (Array.isArray(msgs)) {
		body.messages = msgs.map((msg) => transformSOLOMessage(msg as Record<string, unknown>));
	}

	const model = typeof body.model === 'string' ? body.model : '';
	// 支持 __dev 后缀消除。
	const baseModel = model.includes('__') ? model.split('__')[0]! : model;
	const configName = baseModel || TRAE_DEFAULT_MODEL;
	body.config_name = configName;
	body.model = configName;

	normalizeToolChoice(body);
	normalizeTools(body);

	return body;
}

/** 转换单条消息。 */
function transformSOLOMessage(msg: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...msg };

	// assistant 消息的 tool_calls: function → function_call
	if (result.role === 'assistant') {
		const tcs = result.tool_calls;
		if (Array.isArray(tcs)) {
			const kept: unknown[] = [];
			for (const tc of tcs) {
				if (typeof tc !== 'object' || tc === null) {continue;}
				const t = tc as Record<string, unknown>;
				if (typeof t.function === 'object' && t.function !== null) {
					t.function_call = t.function;
					delete t.function;
				}
				const fc = t.function_call as Record<string, unknown> | undefined;
				if (fc === undefined || typeof fc.name !== 'string' || fc.name.trim().length === 0) {continue;}
				kept.push(t);
			}
			if (kept.length > 0) {
				result.tool_calls = kept;
			} else {
				delete result.tool_calls;
			}
		}
	}

	// content 转换：字符串 → [{type:"text",text:...}]
	const content = result.content;
	if (content === null || content === undefined) {
		// 无 content 的消息（如纯 tool_calls assistant）跳过。
	} else if (typeof content === 'string') {
		result.content = [{ type: 'text', text: content }];
	}
	// 已经是数组 → 透传（兼容多模态）。

	return result;
}

/**
 * `tool_choice` 归一化。
 *
 * - `"none"` / `{type:"none"}` → 删 `tool_choice` + 删 `tools`
 * - `{type:"auto"/"required"}` → 字符串 `"auto"` / `"required"`
 * - `{type:"function",function:{name:"x"}}` → 字符串 `"x"`
 */
function normalizeToolChoice(body: Record<string, unknown>): void {
	const tc = body.tool_choice;
	if (tc === undefined) {return;}

	const suppress = (): void => {
		delete body.tools;
		delete body.functions;
	};

	if (typeof tc === 'string') {
		if (tc.toLowerCase().trim() === 'none') {
			delete body.tool_choice;
			suppress();
		}
		return;
	}

	if (typeof tc === 'object' && tc !== null) {
		const v = tc as Record<string, unknown>;
		const typ = typeof v.type === 'string' ? v.type.toLowerCase().trim() : '';
		switch (typ) {
			case 'none':
				delete body.tool_choice;
				suppress();
				break;
			case 'auto':
			case 'required':
				body.tool_choice = typ;
				break;
			case 'function': {
				const fn = v.function as Record<string, unknown> | undefined;
				let name = typeof fn?.name === 'string' ? fn.name : '';
				if (name.length === 0) {name = typeof v.name === 'string' ? v.name : '';}
				body.tool_choice = name.trim().length > 0 ? name.trim() : 'auto';
				break;
			}
			default:
				delete body.tool_choice;
		}
		return;
	}

	delete body.tool_choice;
}

/**
 * `tools.parameters` 序列化。
 *
 * SOLO 上游要求 `parameters` 是 **string** 类型，OpenAI 标准是 object，
 * 因此须把 parameters 对象序列化为 JSON 字符串。
 */
function normalizeTools(body: Record<string, unknown>): void {
	const raw = body.tools;
	if (!Array.isArray(raw) || raw.length === 0) {return;}

	const out: unknown[] = [];
	for (const item of raw) {
		if (typeof item !== 'object' || item === null) {continue;}
		const t = item as Record<string, unknown>;
		const fn = t.function as Record<string, unknown> | undefined;
		if (fn === undefined) {continue;}
		const params = fn.parameters;
		if (typeof params === 'object' && params !== null) {
			fn.parameters = JSON.stringify(params);
		}
		out.push(t);
	}
	if (out.length > 0) {
		body.tools = out;
	} else {
		delete body.tools;
	}
}

// ── SOLO → OpenAI SSE 解析 ──

/** SOLO SSE 事件类型。 */
export type TraeSSEEventType =
	| 'metadata'
	| 'timing_cost'
	| 'output'
	| 'extra_info'
	| 'token_usage'
	| 'done'
	| 'error';

/** 解析后的单条 SOLO 事件。 */
export interface TraeSSEEvent {
	event: TraeSSEEventType | string;
	response?: string;
	reasoningContent?: string;
	toolCalls?: unknown[];
	usage?: Record<string, unknown>;
	finishReason?: string;
	errorCode?: number;
	errorMessage?: string;
}

/**
 * 解析一条 SOLO 事件（`event:` 行 + `data:` 行的 JSON）。
 *
 * 事件形态：
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
export function parseTraeSSELine(eventName: string, dataLine: string): TraeSSEEvent | undefined {
	const event = eventName.trim();
	if (dataLine.length === 0) {return { event };}

	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(dataLine) as Record<string, unknown>;
	} catch {
		return { event };
	}

	const ev: TraeSSEEvent = { event };
	switch (event) {
		case 'output':
			if (typeof raw.response === 'string') {ev.response = raw.response;}
			if (typeof raw.reasoning_content === 'string') {ev.reasoningContent = raw.reasoning_content;}
			if (Array.isArray(raw.tool_calls)) {ev.toolCalls = normalizeTraeToolCalls(raw.tool_calls);}
			break;
		case 'token_usage':
			ev.usage = raw;
			break;
		case 'done':
			if (typeof raw.finish_reason === 'string') {ev.finishReason = raw.finish_reason;}
			break;
		case 'error':
			if (typeof raw.code === 'number') {ev.errorCode = raw.code;}
			if (typeof raw.message === 'string') {ev.errorMessage = raw.message;}
			break;
	}
	return ev;
}

/**
 * 归一化 SOLO `tool_calls` 的字段（`function_call` → `function`，清理 SOLO 专属字段）。
 */
function normalizeTraeToolCalls(calls: unknown[]): unknown[] {
	return calls.map((call) => {
		if (typeof call !== 'object' || call === null) {return call;}
		const c = { ...(call as Record<string, unknown>) };
		if (typeof c.function_call === 'object' && c.function_call !== null) {
			c.function = { ...(c.function_call as Record<string, unknown>) };
			delete c.function_call;
		}
		if (typeof c.function === 'object' && c.function !== null) {
			const fn = c.function as Record<string, unknown>;
			delete fn.namespace;
			delete fn.partial_arguments;
		}
		return c;
	});
}

/**
 * SOLO `token_usage` 事件 → 上报给 Copilot 的 usage 形状。
 *
 * ## ⚠️ 与参考实现的口径差异（**有意为之**）
 *
 * 参考实现（DSH）把 `prompt_tokens` 减去缓存命中/写入，因为 DSH 的
 * `TokenUsage` 是**互斥口径**（`inputTokens` 不含缓存）。
 *
 * 而 VS Code / Copilot 的 usage 是 **OpenAI 口径**：`prompt_tokens` 是
 * **含缓存的总输入**，缓存命中单列在 `prompt_tokens_details.cached_tokens`。
 * 故这里**不做减法**，原样上报 `prompt_tokens`，把命中量放进 details。
 *
 * 上游字段（实测）：
 * ```json
 * {"prompt_tokens":5144,"completion_tokens":32,"total_tokens":5176,
 *  "cache_creation_input_tokens":0,"cache_read_input_tokens":5120,
 *  "reasoning_tokens":30,"cluster":"normal_context"}
 * ```
 *
 * ⚠️ 早期实现只读 `prompt_tokens` / `completion_tokens`，把
 * `cache_read_input_tokens` 整对丢弃 ⇒ 界面缓存命中率恒显示 0%。
 */
export interface TraeUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/** 缓存命中（`cache_read_input_tokens`）。 */
	cacheReadTokens: number;
	/** 缓存写入（`cache_creation_input_tokens`）。 */
	cacheWriteTokens: number;
	/** 思考 token（`reasoning_tokens`）。 */
	reasoningTokens: number;
}

/** 解析 `token_usage` 事件为上报用的 usage。 */
export function traeUsageFromTokenUsage(raw: Record<string, unknown>): TraeUsage {
	const num = (value: unknown): number =>
		typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;

	const promptTokens = num(raw.prompt_tokens);
	const completionTokens = num(raw.completion_tokens);
	const totalTokens = num(raw.total_tokens) || promptTokens + completionTokens;
	return {
		promptTokens,
		completionTokens,
		totalTokens,
		cacheReadTokens: num(raw.cache_read_input_tokens),
		cacheWriteTokens: num(raw.cache_creation_input_tokens),
		reasoningTokens: num(raw.reasoning_tokens),
	};
}

/**
 * 组合 SOLO **流内** `event:error` 的文案。
 *
 * `code=4001` 的上游原文是 *"We're sorry, the param is invalid. Please try with a
 * valid param."* —— 实测该码**只**由**不可调用的模型**触发（`is_custom_model`
 * 为 true 的条目），与「提示词/参数格式有误」毫无关系，原文会把排查方向
 * **完全带偏**。故对 4001 追加一句指向真实成因的可操作提示。
 *
 * ⚠️ **不列具体模型名**：那份快照会随服务端下发变化（复测时已完全失效），
 * 把某一刻的名单写成判据会让后人误删合法模型。
 */
export function traeStreamErrorMessage(code: number, message: string, model: string): string {
	const base = `TRAE: ${message} (code=${code})`;
	if (code === 4006) {
		// 上游原文 *"We're sorry, the content is too large for AI to understand."*
		// 说的是**这一次请求的载荷**太大（实测约 (21,24] 张 2560×1600 原图）。
		return `${base} —— 本次请求的内容过大：多为一次携带的图片过多/过大。`
			+ '请减少本轮的图片数量或改用更小的截图后重试。';
	}
	if (code !== 4001) {return base;}
	return `${base} —— 模型「${model}」不被上游接受：它通常是「仅可见但不可调用」的`
		+ '自定义模型（需先在 TRAE IDE 内自行配置供应商），请改用模型列表中的其它模型';
}

/** 由「基础 device_id + 代次」派生设备号（hex32）；`generation <= 0` 时原样返回。 */
export function deriveDeviceId(baseDeviceId: string, generation: number): string {
	if (!Number.isFinite(generation) || generation <= 0) {return baseDeviceId;}
	return createHash('sha256')
		.update(`${baseDeviceId}#gen${Math.floor(generation)}`, 'utf8')
		.digest('hex')
		.slice(0, 32);
}
