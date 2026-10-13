// Qoder（中国版）设备码登录流程（PKCE + 轮询）与凭据续期。
//
// ## 与其它 provider 的差异
//
// CodeBuddy 走 external-link 轮询；Qoder 是**设备码流程**：它的 `redirect_uri`
// 是自定义协议 `qoder-app://`，官方 CLI 的做法是「打开授权页 → 轮询
// `/api/v1/deviceToken/poll`」。本模块照搬该模式 —— 不起监听端口，
// 也就没有端口泄漏与回调伪造问题。
//
// 移植自 `deepseek-harness-codearts/src/qoder-oauth.ts`，接口改为配合
// VS Code `SecretStorage` 与 `CancellationToken`。

import * as vscode from 'vscode';
import {
	QODER_LOGIN_TIMEOUT_MS,
	QODER_POLL_INTERVAL_MS,
	QODER_POLL_MAX_FAILURES,
	QODER_REQUEST_TIMEOUT_MS,
	QODER_REFRESH_PATH,
	applyQoderRefresh,
	buildQoderAuthUrl,
	buildQoderCredential,
	buildQoderPollUrl,
	createQoderDeviceSession,
	fetchQoderUserNickname,
	isQoderRefreshable,
	parseQoderTokenPayload,
	qoderCredentialExpiresAtMs,
	qoderRefreshBody,
	withQoderNickname,
	type QoderCredential,
	type QoderDeviceSession,
	type QoderTokenPayload,
	QODER_CN,
} from './qoder-cn';

/** 本函数自身抛出的确定性错误前缀（用于与网络错误区分）。 */
const SERVER_ERROR_PREFIX = '登录服务返回异常';

/** 轮询 deadline 是否已过。 */
function sleep(ms: number, token: vscode.CancellationToken): Promise<void> {
	return new Promise((resolve, reject) => {
		if (token.isCancellationRequested) {
			reject(new Error('登录已取消'));
			return;
		}
		const timer = setTimeout(() => {
			disposable.dispose();
			resolve();
		}, ms);
		const disposable = token.onCancellationRequested(() => {
			clearTimeout(timer);
			disposable.dispose();
			reject(new Error('登录已取消'));
		});
	});
}

/**
 * 轮询直到拿到 token。
 *
 * **404 表示「用户尚未完成授权」，必须继续轮询**。网络失败容忍
 * {@link QODER_POLL_MAX_FAILURES} 次连续失败；其它非 2xx 立即抛错。
 */
async function pollQoderDeviceToken(
	session: QoderDeviceSession,
	token: vscode.CancellationToken,
): Promise<QoderTokenPayload> {
	const pollUrl = buildQoderPollUrl(session);
	const deadline = Date.now() + QODER_LOGIN_TIMEOUT_MS;
	let failures = 0;

	while (Date.now() < deadline) {
		if (token.isCancellationRequested) {
			throw new Error('登录已取消');
		}
		try {
			const controller = new AbortController();
			const cancellation = token.onCancellationRequested(() => controller.abort());
			let response: Response;
			try {
				response = await fetch(pollUrl, {
					method: 'GET',
					headers: { Accept: 'application/json' },
					signal: controller.signal,
				});
			} finally {
				cancellation.dispose();
			}
			failures = 0;
			if (response.status === 404) {
				await sleep(QODER_POLL_INTERVAL_MS, token);
				continue;
			}
			if (!response.ok) {
				throw new Error(`${SERVER_ERROR_PREFIX}（HTTP ${response.status}）`);
			}
			const payload = parseQoderTokenPayload(await response.json() as unknown);
			if (payload.accessToken.length > 0) {
				return payload;
			}
			await sleep(QODER_POLL_INTERVAL_MS, token);
		} catch (error) {
			if (token.isCancellationRequested) {
				throw new Error('登录已取消');
			}
			if (error instanceof Error && error.message.startsWith(SERVER_ERROR_PREFIX)) {
				throw error;
			}
			failures += 1;
			if (failures >= QODER_POLL_MAX_FAILURES) {
				throw new Error(
					`无法连接 Qoder 登录服务（连续 ${failures} 次失败）：`
					+ `${error instanceof Error ? error.message : String(error)}`,
				);
			}
			await sleep(QODER_POLL_INTERVAL_MS, token);
		}
	}
	throw new Error('登录等待已超时，请重新发起登录');
}

/** 把凭据存进 SecretStorage。 */
async function storeCredential(
	secrets: vscode.SecretStorage,
	secretKey: string,
	credential: QoderCredential,
): Promise<void> {
	await secrets.store(secretKey, JSON.stringify(credential));
}

/**
 * 运行完整登录流程：打开授权页 → 轮询 → 落库 → 补昵称。
 *
 * 阻塞语义：等用户完成授权后才返回。
 */
export async function loginQoderCn(
	secrets: vscode.SecretStorage,
	secretKey: string,
	token: vscode.CancellationToken,
): Promise<void> {
	const session = createQoderDeviceSession();
	const authUrl = buildQoderAuthUrl(session);
	await vscode.env.openExternal(vscode.Uri.parse(authUrl));

	const payload = await pollQoderDeviceToken(session, token);
	if (payload.accessToken.length === 0) {
		throw new Error('登录响应缺少访问令牌');
	}
	let credential = buildQoderCredential(payload, { machineId: session.machineId });
	// 设备码响应通常不带 user_name，补一次 userinfo 拿可读昵称（失败不阻断登录）。
	const nickname = await fetchQoderUserNickname(credential);
	credential = withQoderNickname(credential, nickname);
	await storeCredential(secrets, secretKey, credential);
}

/** 解析 SecretStorage 里的凭据；缺失或损坏时返回 undefined。 */
export async function readQoderCnCredential(
	secrets: vscode.SecretStorage,
	secretKey: string,
): Promise<QoderCredential | undefined> {
	const value = await secrets.get(secretKey);
	if (value === undefined) {
		return undefined;
	}
	let credential: QoderCredential;
	try {
		credential = JSON.parse(value) as QoderCredential;
	} catch {
		throw new Error('Qoder 凭据格式无效，请重新登录');
	}
	if (typeof credential.access_token !== 'string' || credential.access_token.length === 0) {
		throw new Error('Qoder 凭据缺少访问令牌，请重新登录');
	}
	return credential;
}

/**
 * 静默续期：`refresh_token` + `machine_id` 换取新令牌。
 *
 * 终态判定：HTTP 401/403、或响应缺 token → 抛错（需重新登录）；
 * 其余错误（网络抖动、5xx、429）→ 抛普通 Error（可重试）。
 */
export async function refreshQoderCnCredential(
	credential: QoderCredential,
): Promise<QoderCredential> {
	let response: Response;
	try {
		response = await fetch(`${QODER_CN.openApiBase}${QODER_REFRESH_PATH}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				'User-Agent': `${QODER_CN.userAgentPrefix}/1.0.0`,
			},
			body: JSON.stringify(qoderRefreshBody(credential)),
			signal: AbortSignal.timeout(QODER_REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		throw new Error(`Qoder 续期网络失败：${error instanceof Error ? error.message : String(error)}`);
	}

	if (response.status === 401 || response.status === 403) {
		throw new Error(`Qoder 登录凭据已过期（HTTP ${response.status}），请重新登录`);
	}

	let parsed: unknown;
	try {
		parsed = await response.json();
	} catch {
		throw new Error(`Qoder 续期响应不是 JSON（HTTP ${response.status}）`);
	}

	if (!response.ok) {
		const detail = JSON.stringify(parsed).slice(0, 200);
		throw new Error(`Qoder 续期失败（HTTP ${response.status}）：${detail}`);
	}

	const payload = parseQoderTokenPayload(parsed);
	if (payload.accessToken.length === 0) {
		throw new Error('Qoder 续期响应缺少访问令牌，请重新登录');
	}
	return applyQoderRefresh(credential, payload);
}

/**
 * 读取凭据并在**即将过期**时静默续期，返回可用的最新凭据。
 *
 * 与其他 provider 一致：留 60 秒余量，避免刚判为有效、发请求时已过期。
 */
export async function resolveQoderCnCredential(
	secrets: vscode.SecretStorage,
	secretKey: string,
): Promise<QoderCredential | undefined> {
	let credential = await readQoderCnCredential(secrets, secretKey);
	if (credential === undefined) {
		return undefined;
	}
	const expiresAt = qoderCredentialExpiresAtMs(credential);
	const soon = expiresAt !== undefined && expiresAt <= Date.now() + 60_000;
	if (!soon || !isQoderRefreshable(credential)) {
		return credential;
	}
	credential = await refreshQoderCnCredential(credential);
	await storeCredential(secrets, secretKey, credential);
	return credential;
}

/**
 * 补 `uid`（加密推理必需）。
 *
 * ⚠️ `uid` 是加密签名必需字段；缺它时 WASM 会产出签名无效的请求，
 * 服务端回 `Signature invalid (101)`。旧凭据或某些登录响应可能没有它，
 * 这里经 userinfo 补一次并回写。
 */
export async function ensureQoderCnUid(
	secrets: vscode.SecretStorage,
	secretKey: string,
	credential: QoderCredential,
): Promise<QoderCredential> {
	if (credential.uid !== undefined && credential.uid.length > 0) {
		return credential;
	}
	try {
		const response = await fetch(`${QODER_CN.openApiBase}${'/api/v1/userinfo'}`, {
			method: 'GET',
			headers: {
				Accept: 'application/json',
				Authorization: `Bearer ${credential.security_oauth_token || credential.access_token}`,
			},
			signal: AbortSignal.timeout(QODER_REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			return credential;
		}
		const body: unknown = await response.json();
		if (typeof body !== 'object' || body === null) {
			return credential;
		}
		const record = body as Record<string, unknown>;
		const uid = typeof record.uid === 'string' && record.uid.length > 0
			? record.uid
			: typeof record.user_id === 'string' && record.user_id.length > 0 ? record.user_id : undefined;
		if (uid === undefined) {
			return credential;
		}
		const patched: QoderCredential = { ...credential, uid };
		await storeCredential(secrets, secretKey, patched);
		return patched;
	} catch {
		return credential;
	}
}
