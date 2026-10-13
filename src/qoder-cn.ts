// Qoder（中国版）协议的类型与纯函数。
//
// 全部逻辑都是**可单测的纯计算**（PKCE、URL、凭据形状、续期载荷），
// 与网络 I/O 分离 —— 这样协议细节能被单测直接覆盖，不需要 mock fetch。
//
// ## 协议源流
//
// 移植自 `deepseek-harness-codearts/src/qoder.ts`（Qoder 国际版/中国版共用同一套
// 协议实现，差异全在产品配置里）。本文件是**中国版**的单产品配置版。
//
// ## 中国版关键差异（相对国际版）
//
// | 维度 | 国际版 | 中国版 |
// |---|---|---|
// | authBase | `https://qoder.com` | `https://qoder.cn` |
// | openApiBase | `https://openapi.qoder.sh` | `https://openapi.qoder.com.cn` |
// | 加密推理 host | `https://api2.qoder.sh` | `https://gateway.qoder.com.cn` |
// | client_id | `e883ade2-…` | `732aef47-9cf2-46a2-95fe-4cebb5d0d1fa` |
//
// 登录流程：**PKCE 设备码 + 轮询**（不起本地回调服务器）。

import { createHash, randomUUID, randomBytes } from 'node:crypto';

/** 单次 HTTP 请求超时（毫秒）。 */
export const QODER_REQUEST_TIMEOUT_MS = 30_000;
/** 登录等待总超时（毫秒）。 */
export const QODER_LOGIN_TIMEOUT_MS = 300_000;
/** 轮询间隔（毫秒）。 */
export const QODER_POLL_INTERVAL_MS = 1_000;
/** 轮询连续网络失败上限。本实现放宽到 5 以容忍抖动。 */
export const QODER_POLL_MAX_FAILURES = 5;

/** 授权页路径（挂 `authBase`）。 */
export const QODER_DEVICE_SELECT_PATH = '/device/selectAccounts';
/** 轮询取 token 路径（挂 `openApiBase`）。 */
export const QODER_POLL_PATH = '/api/v1/deviceToken/poll';
/** 续期路径（挂 `openApiBase`）。 */
export const QODER_REFRESH_PATH = '/api/v1/deviceToken/refresh';
/** 用户信息路径（挂 `openApiBase`）。 */
export const QODER_USERINFO_PATH = '/api/v1/userinfo';

/** 中国版产品配置。 */
export const QODER_CN = {
	/** provider 路由名（与 package.json 的 `languageModelChatProviders.vendor` 对应）。 */
	id: 'qodercn',
	/** 设置页 / 模型选择器展示名。 */
	displayName: 'Qoder (中国版)',
	/** 登录与 OAuth 基址。 */
	authBase: 'https://qoder.cn',
	/** OpenAPI 基址（轮询、续期、userinfo 都走它）。 */
	openApiBase: 'https://openapi.qoder.com.cn',
	/**
	 * **加密推理**基址（`agent_chat_generation` 端点所在 host）。
	 *
	 * ⚠️ 中国版的 `algo` 网关是 `gateway.qoder.com.cn`；国际版是 `api2.qoder.sh`。
	 * 走公开 OpenAI 兼容端点在 CN 实测 503（alb 无上游路由），故只走加密端点。
	 */
	encryptedInferBase: 'https://gateway.qoder.com.cn',
	/** OAuth client id（取自 CN 客户端 asar 的 `authClientIds.prod`）。 */
	clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
	/** 请求体 `metadata.context` 的客户端标识（CLI 身份）。 */
	clientMetadata: {
		client_type: '5',
		business_product: 'cli',
		business_type: 'agent',
		scene: 'assistant',
	},
	/**
	 * 加密推理请求体的 `session_type`。
	 *
	 * ⚠️ 国内版客户端用 `qoder_work`（源码 `l7A`），国际版用 `qodercli`（`swe`）。
	 */
	sessionType: 'qoder_work',
	/** `User-Agent` 头取值前缀。 */
	userAgentPrefix: 'qoder',
	/** 默认凭据 ref（单凭据模式）。 */
	defaultCredentialRef: 'QODERCN_ACCESS_TOKEN',
} as const;

/** PKCE 字符集（RFC 7636 的 unreserved 集合，共 66 个）。 */
const PKCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** 一次 PKCE 生成的结果。 */
export interface QoderPkce {
	/** 明文 verifier（轮询时提交）。 */
	verifier: string;
	/** `base64url(sha256(verifier))`，**无 padding**。 */
	challenge: string;
}

/**
 * 生成 PKCE verifier / challenge。
 *
 * verifier 长度取 43..128，challenge 用 `base64url(sha256(verifier))` 且**去掉 padding**
 * —— 带 `=` 会让服务端校验失败。
 */
export function createQoderPkce(): QoderPkce {
	const length = 43 + Math.floor(86 * Math.random());
	const bytes = randomBytes(length);
	let verifier = '';
	for (let i = 0; i < length; i++) {
		verifier += PKCE_ALPHABET[bytes[i]! % PKCE_ALPHABET.length];
	}
	const challenge = createHash('sha256').update(verifier).digest()
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
	return { verifier, challenge };
}

/**
 * 一次设备登录会话。
 *
 * `machineId` 由本插件生成并随凭据持久化，不是硬件指纹。
 */
export interface QoderDeviceSession {
	pkce: QoderPkce;
	/** 一次性随机串（UUID）。 */
	nonce: string;
	/** 设备标识（本插件生成的随机 UUID，需持久化）。 */
	machineId: string;
}

/** 生成一次性设备登录会话。 */
export function createQoderDeviceSession(machineId?: string): QoderDeviceSession {
	return {
		pkce: createQoderPkce(),
		nonce: randomUUID(),
		machineId: machineId ?? randomUUID(),
	};
}

/**
 * 构造浏览器授权 URL。
 *
 * 形态：`{authBase}/device/selectAccounts?challenge&challenge_method=S256&nonce&machine_id&client_id`
 */
export function buildQoderAuthUrl(session: QoderDeviceSession): string {
	const query = new URLSearchParams({
		challenge: session.pkce.challenge,
		challenge_method: 'S256',
		nonce: session.nonce,
		machine_id: session.machineId,
		client_id: QODER_CN.clientId,
	});
	return `${QODER_CN.authBase}${QODER_DEVICE_SELECT_PATH}?${query.toString()}`;
}

/**
 * 构造轮询 URL。
 *
 * ⚠️ 挂 **`openApiBase`**，不是 `authBase`。写错 host 会让登录永远失败。
 */
export function buildQoderPollUrl(session: QoderDeviceSession): string {
	const query = new URLSearchParams({
		nonce: session.nonce,
		verifier: session.pkce.verifier,
		challenge_method: 'S256',
	});
	return `${QODER_CN.openApiBase}${QODER_POLL_PATH}?${query.toString()}`;
}

/**
 * 凭据。
 *
 * `security_oauth_token` 与 `access_token` **双写同值**：Qoder 的取用顺序是
 * `security_oauth_token ?? access_token`，双写可兼容两种路径。
 *
 * `machine_id` **必须持久化**：续期请求体需要它，且它参与服务端的设备绑定。
 */
export interface QoderCredential {
	security_oauth_token: string;
	access_token: string;
	refresh_token?: string;
	/** 访问令牌过期时间（毫秒时间戳）。 */
	expire_time?: number;
	/** refresh_token 过期时间（毫秒时间戳）。 */
	refresh_token_expire_time?: number;
	/** 本插件生成并持久化的设备标识。 */
	machine_id: string;
	/** 用户 id（设备码响应里的 `user_id`）。**加密推理必需**。 */
	uid?: string;
	/** 展示用昵称（设备码响应 `user_name` 或后续 userinfo）。 */
	nickname?: string;
}

/** 从 token 响应解析出的规范化载荷。 */
export interface QoderTokenPayload {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
	refreshTokenExpiresAt?: number;
	uid?: string;
	userName?: string;
}

/** 读字符串字段（容忍非字符串与缺失）。 */
function readString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === 'string' && value.length > 0) {
			return value;
		}
	}
	return undefined;
}

/**
 * 把时间值解析成毫秒时间戳。
 *
 * 兼容 ISO 字符串与数字（秒或毫秒）。无法解析时返回 undefined
 * —— **绝不填 0**：「没有过期时间」与「1970 年过期」是两回事。
 */
function readTimestamp(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		// 10 位视为秒，13 位视为毫秒
		return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
	}
	if (typeof value === 'string' && value.length > 0) {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/** 解析 token 响应（登录响应用 `token`，续期响应用 `device_token`）。 */
export function parseQoderTokenPayload(value: unknown): QoderTokenPayload {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return { accessToken: '' };
	}
	const source = value as Record<string, unknown>;
	const accessToken = readString(source, ['token', 'device_token', 'access_token']) ?? '';
	const refreshToken = readString(source, ['refresh_token', 'refreshToken']);
	const expiresAt = readTimestamp(source.expires_at ?? source.expiresAt);
	const refreshTokenExpiresAt = readTimestamp(
		source.refresh_token_expires_at ?? source.refreshTokenExpiresAt,
	);
	const uid = readString(source, ['user_id', 'userId']);
	const userName = readString(source, ['user_name', 'userName']);
	return {
		accessToken,
		...(refreshToken === undefined ? {} : { refreshToken }),
		...(expiresAt === undefined ? {} : { expiresAt }),
		...(refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt }),
		...(uid === undefined ? {} : { uid }),
		...(userName === undefined ? {} : { userName }),
	};
}

/** 构造凭据。 */
export function buildQoderCredential(
	payload: QoderTokenPayload,
	extra: { machineId: string; nickname?: string },
): QoderCredential {
	const nickname = extra.nickname !== undefined && extra.nickname.length > 0
		? extra.nickname
		: payload.userName;
	return {
		security_oauth_token: payload.accessToken,
		access_token: payload.accessToken,
		...(payload.refreshToken === undefined ? {} : { refresh_token: payload.refreshToken }),
		...(payload.expiresAt === undefined ? {} : { expire_time: payload.expiresAt }),
		...(payload.refreshTokenExpiresAt === undefined
			? {} : { refresh_token_expire_time: payload.refreshTokenExpiresAt }),
		machine_id: extra.machineId,
		...(payload.uid === undefined ? {} : { uid: payload.uid }),
		...(nickname === undefined || nickname.length === 0 ? {} : { nickname }),
	};
}

/** 凭据的访问令牌过期时间（毫秒）；未知时 undefined。 */
export function qoderCredentialExpiresAtMs(credential: QoderCredential): number | undefined {
	return credential.expire_time;
}

/** 是否可静默续期（判据是「有 refresh_token」）。 */
export function isQoderRefreshable(credential: QoderCredential): boolean {
	return typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0;
}

/** 访问令牌是否已过期。无过期时间时保守视为未过期（交给服务端 401 判定）。 */
export function isQoderExpired(credential: QoderCredential, nowMs: number = Date.now()): boolean {
	const expiresAt = qoderCredentialExpiresAtMs(credential);
	return expiresAt !== undefined && expiresAt <= nowMs;
}

/** 续期请求体。 */
export function qoderRefreshBody(credential: QoderCredential): Record<string, string> {
	return {
		refresh_token: credential.refresh_token ?? '',
		machine_id: credential.machine_id,
	};
}

/** 取 Bearer 令牌（`security_oauth_token` 优先）。 */
export function qoderBearerToken(credential: QoderCredential): string {
	const token = credential.security_oauth_token;
	if (typeof token === 'string' && token.length > 0) {
		return token;
	}
	return typeof credential.access_token === 'string' ? credential.access_token : '';
}

/**
 * 用续期结果覆盖旧凭据。
 *
 * **保留** `machine_id` / `uid` / `nickname`：它们不在续期响应里，
 * 丢失会让下一次续期缺少设备标识、或让加密推理缺少 uid。
 */
export function applyQoderRefresh(
	credential: QoderCredential,
	payload: QoderTokenPayload,
): QoderCredential {
	const next = buildQoderCredential(payload, {
		machineId: credential.machine_id,
		...(credential.nickname === undefined ? {} : { nickname: credential.nickname }),
	});
	if (next.refresh_token === undefined && credential.refresh_token !== undefined) {
		next.refresh_token = credential.refresh_token;
	}
	if (next.uid === undefined && credential.uid !== undefined) {
		next.uid = credential.uid;
	}
	return next;
}

/**
 * 取用户的展示名（`GET /api/v1/userinfo` 的 `name`）。
 *
 * 设备码轮询响应里通常**没有** `user_name`，故登录后必须补一次 userinfo
 * 才能拿到可读的名字（唯一可靠来源）。失败时返回 `undefined` 而**不抛错**。
 */
export async function fetchQoderUserNickname(
	credential: QoderCredential,
	fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
	try {
		const response = await fetcher(`${QODER_CN.openApiBase}${QODER_USERINFO_PATH}`, {
			method: 'GET',
			headers: {
				Accept: 'application/json',
				Authorization: `Bearer ${qoderBearerToken(credential)}`,
			},
		});
		if (!response.ok) {
			return undefined;
		}
		const body: unknown = await response.json();
		if (typeof body !== 'object' || body === null) {
			return undefined;
		}
		const name = (body as Record<string, unknown>).name;
		if (typeof name !== 'string') {
			return undefined;
		}
		const trimmed = name.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

/** 把昵称写进凭据（返回新对象，不改原凭据）。 */
export function withQoderNickname(
	credential: QoderCredential,
	nickname: string | undefined,
): QoderCredential {
	if (nickname === undefined || nickname.length === 0) {
		return credential;
	}
	return { ...credential, nickname };
}
