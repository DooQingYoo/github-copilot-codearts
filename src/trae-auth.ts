// TRAE（字节跳动 TRAE IDE）登录流程与凭据续期。
//
// ## 登录方式：本地回调（与 CodeBuddy / Qoder 都不同）
//
// TRAE 登录页 `https://www.trae.cn/authorization` 强制回调
// `http://127.0.0.1:18080/authorize`，且回调**直接回传 token**
// （`?refreshToken=...&userInfo={...}&userJwt={...}`），不是 OAuth 的 `?code=` 交换。
//
// ## ⚠️ 回调参数一个都不能少（真实缺陷）
//
// 早期实现只发了 `client_id` / `machine_id` / `device_id` / `callback_url` /
// `redirect_uri` 五个参数 —— 与真实协议**完全不匹配**：
//
// 1. **回调地址的参数名是 `auth_callback_url`**，不是 `callback_url`
//    （也没有 `redirect_uri`）。名字错了，TRAE 拿不到回调地址，登录页会
//    **永远停在授权中**，既不跳转也不回传任何东西。
// 2. `auth_from` / `login_channel` / `auth_type` / `redirect` 决定走哪条授权通道；
//    缺失时授权流程不会走到本地回传分支。
// 3. `login_trace_id` 是回调**反查 pending** 的唯一凭据。
// 4. `x_*` 系列是客户端形态伪装（设备/应用信息），缺席可能被风控拦截。
//
// ## ⚠️ 回调**没有** `code` 参数
//
// 真实回调形如：
// ```
// http://127.0.0.1:18080/authorize?refreshToken=...&userInfo={...}&userJwt={...}
// ```
// 即它**直接回传 token**。早期实现按 OAuth 惯例去找 `?code=`，于是
// `parseAuthCode` **恒返回 undefined** → 回调服务器回 400 → 结果 Promise
// 永不落定 → 前端永远拿不到 `done:true` → **网页一直停在认证中**。
//
// ⚠️ 但「带 code」的回调**不是**无效回调：TRAE 授权页并存两套流程
// （新流程走 PKCE 回带 `code` / `authCodeInfo`，老流程直传 `refreshToken`）。
// 本实现对两种形态都返回结果，对 PKCE 形态给出**精确报错**而不是含糊的
// 「缺少 refreshToken」。

import { createServer, type Server } from 'node:http';
import * as vscode from 'vscode';
import {
	TRAE_AGENT_HOST,
	TRAE_BATCH_MODELS_PATH,
	TRAE_CALLBACK_PATH,
	TRAE_CLIENT_ID,
	TRAE_CONSOLE_HOST,
	TRAE_EXCHANGE_PATH,
	TRAE_IDE_VERSION,
	TRAE_LOGIN_TIMEOUT_MS,
	TRAE_OAUTH_HOST,
	TRAE_PLUGIN_VERSION,
	TRAE_QUERY_FUNCTIONS,
	TRAE_REQUEST_TIMEOUT_MS,
	TRAE_USER_INFO_PATH,
	applyTraeRefresh,
	buildTraeCredential,
	generateDeviceId,
	generateMachineId,
	isTraeRefreshable,
	machineTraceId,
	parseTraeExchangeResponse,
	parseTraeUserInfoResponse,
	traeCredentialExpiresAtMs,
	traeOAuthHeaders,
	traeSOLOHeaders,
	type TraeCredential,
	type TraeExchangeResult,
	type TraeUserInfoResult,
} from './trae';
import { classifyTraeError, isTraeTerminalError } from './trae-errors';

/** 回调端口：TRAE 默认 18080（被占用时自动回退随机端口）。 */
const TRAE_CALLBACK_PORT = 18080;

/** 本模块自身抛出的确定性错误前缀（用于与网络错误区分）。 */
const SERVER_ERROR_PREFIX = 'TRAE 登录服务返回异常';

// ── 登录 URL ──

/**
 * 构建 TRAE 登录 URL（**完整 17 参数集**）。
 *
 * ⚠️ 参数名与数量都不可改，理由见文件头注释。
 */
export function buildTraeLoginURL(machineId: string, deviceId: string, callbackUrl: string): string {
	const params = new URLSearchParams({
		login_version: '1',
		auth_from: 'solo',
		login_channel: 'native_ide',
		plugin_version: TRAE_PLUGIN_VERSION,
		auth_type: 'local',
		client_id: TRAE_CLIENT_ID,
		redirect: '0',
		login_trace_id: machineTraceId(machineId, deviceId),
		// ⚠️ 参数名必须是 auth_callback_url（见文件头注释）。
		auth_callback_url: callbackUrl,
		machine_id: machineId,
		device_id: deviceId,
		x_device_id: deviceId,
		x_machine_id: machineId,
		x_device_brand: 'PC',
		x_device_type: 'PC',
		x_os_version: '1.0',
		x_app_version: TRAE_IDE_VERSION,
		x_app_type: 'stable',
	});
	return `${TRAE_CONSOLE_HOST}/authorization?${params.toString()}`;
}

// ── 回调解析 ──

/** TRAE 登录回调解出的原始凭证。 */
export interface TraeCallbackInfo {
	/** 优先取 `query.refreshToken`；缺失时回退 `userJwt.RefreshToken`。 */
	refreshToken: string;
	/** 无 refreshToken 时的兜底 access token（`userJwt.Token`）。 */
	accessToken: string;
	uid: string;
	nickname: string;
	/** ⚠️ 回调里字段名是 **TenantID**（不是 EnterpriseID）。 */
	enterpriseId: string;
	/** PKCE 新流程携带的授权码（`code` / `authCodeInfo.code`）。 */
	authCode?: string;
}

/** `parseTraeCallback` 的详细结果（除「解出了什么」还回答「为什么没解出来」）。 */
export type TraeCallbackParseResult =
	| { ok: true; info: TraeCallbackInfo }
	| { ok: false; reason: string; authCodeFlow: boolean };

/**
 * 解析回调里 URL 编码的 JSON 参数（`userInfo` / `userJwt`）。
 *
 * `URLSearchParams` 已解一层 percent-encoding，但 TRAE 的 `userInfo` 中文
 * 存在**双重编码**（实测昵称乱码 `Óû§8847309959`），故再容错解一层。
 */
function parseJsonParam(raw: string | null): Record<string, unknown> | undefined {
	if (raw === null || raw.length === 0) {return undefined;}
	const candidates = [raw];
	try {
		const unescaped = decodeURIComponent(raw);
		if (unescaped !== raw) {candidates.push(unescaped);}
	} catch { /* 非法编码：只用原串 */ }
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch { /* 试下一个 */ }
	}
	return undefined;
}

/** 从 JSON 对象读字符串（兼容数字）。 */
function jsonString(source: Record<string, unknown> | undefined, key: string): string {
	if (source === undefined) {return '';}
	const value = source[key];
	if (typeof value === 'string') {return value;}
	if (typeof value === 'number' && Number.isFinite(value)) {return String(value);}
	return '';
}

/**
 * 修复回调 `userInfo.ScreenName` 的**双重编码乱码**。
 *
 * TRAE 回调的中文昵称会被错误地按 latin-1 解读一次，实测得到
 * `Óû§8847309959` 这类乱码。尝试回转编码；无法修复且**不含任何 CJK 字符**时，
 * 回退为「用户+uid末4位」。
 */
export function fixNicknameMojibake(raw: string, uid: string): string {
	if (raw.length === 0) {return raw;}
	// 只尝试 latin1：Node 的 Buffer 没有 cp1252 编码名。
	try {
		const fixed = Buffer.from(raw, 'latin1').toString('utf8');
		if (fixed.length > 0 && !fixed.includes('\uFFFD')
			&& [...fixed].every((ch) => ch.charCodeAt(0) >= 32)) {
			return fixed;
		}
	} catch { /* 解码失败：走下面的兜底 */ }
	// 无 CJK → 判定为乱码，回退到可读占位（防止把乱码写进凭据）。
	if (!/[\u4e00-\u9fff]/.test(raw)) {return `用户${uid.slice(-4)}`;}
	return raw;
}

/**
 * 解析 TRAE 登录回调 URL，提取凭证字段。
 *
 * 对「token 直传」与「PKCE 带 code」两种形态**都返回结果**：
 * - 有 token（refreshToken / userJwt.Token）→ 正常解出；
 * - 只有 `code` / `authCodeInfo` → 也解出，把 code 放进 `authCode`，
 *   由调用方**明确报出「上游走了 PKCE 流程，本实现暂不支持」**。
 */
export function parseTraeCallbackDetailed(rawUrl: string): TraeCallbackParseResult {
	let query: URLSearchParams;
	try {
		// 允许传入相对形式（`/authorize?...`），补全成完整 URL 再解析。
		query = new URL(rawUrl.startsWith('http') ? rawUrl : `http://127.0.0.1${rawUrl}`).searchParams;
	} catch {
		return { ok: false, reason: '回调 URL 无法解析', authCodeFlow: false };
	}

	const userInfo = parseJsonParam(query.get('userInfo'));
	const userJwt = parseJsonParam(query.get('userJwt'));

	let refreshToken = query.get('refreshToken') ?? '';
	const uid = jsonString(userInfo, 'UserID');
	const nicknameRaw = jsonString(userInfo, 'ScreenName');
	// ⚠️ 回调字段名是 TenantID。
	const enterpriseId = jsonString(userInfo, 'TenantID');

	const jwtToken = jsonString(userJwt, 'Token');
	const jwtRefresh = jsonString(userJwt, 'RefreshToken');

	// query 缺 refreshToken 时回退 userJwt.RefreshToken。
	if (refreshToken.length === 0) {refreshToken = jwtRefresh;}

	// ── PKCE 形态探测：code / authCodeInfo.code ──
	const authCodeInfo = parseJsonParam(query.get('authCodeInfo'));
	// ⚠️ 逐个来源取第一个**非空**值，不能用 `??` 串起来：`jsonString` 取不到时
	// 返回**空串**而非 undefined，空串不是 nullish，会让后续来源永远短路掉。
	const authCodeCandidates: string[] = [
		query.get('code') ?? '',
		query.get('authCode') ?? '',
		jsonString(authCodeInfo, 'code'),
		jsonString(authCodeInfo, 'authCode'),
		// authCodeInfo 为**纯 code 字符串**（非 JSON）时 parseJsonParam 解不出。
		query.get('authCodeInfo') ?? '',
	];
	const authCode = authCodeCandidates.find((candidate) => candidate.trim().length > 0)?.trim() ?? '';

	const info: TraeCallbackInfo = {
		refreshToken,
		// 仅在「无 refreshToken」时才用 userJwt.Token 兜底。
		accessToken: refreshToken.length === 0 ? jwtToken : '',
		uid,
		nickname: fixNicknameMojibake(nicknameRaw, uid),
		enterpriseId,
	};
	if (authCode.length > 0) {info.authCode = authCode;}

	if (info.refreshToken.length === 0 && info.accessToken.length === 0) {
		if (authCode.length > 0) {
			// ⚠️ 关键：这是**合法回调**，只是走了我们尚未支持的 PKCE 分支。
			// 不能判为「无效」，否则用户看到的错误会指向完全错误的方向。
			return {
				ok: false,
				authCodeFlow: true,
				reason: '上游返回了 PKCE 授权码（code/authCodeInfo），本实现暂不支持该流程；'
					+ '请确认 TRAE 授权页是否已切换到新流程',
			};
		}
		return {
			ok: false,
			authCodeFlow: false,
			reason: '回调未携带 refreshToken / userJwt.Token / code',
		};
	}
	return { ok: true, info };
}

/** 解析回调（只关心成功与否时用）。 */
export function parseTraeCallback(rawUrl: string): TraeCallbackInfo | undefined {
	const result = parseTraeCallbackDetailed(rawUrl);
	return result.ok ? result.info : undefined;
}

// ── 换取凭据 ──

/**
 * 用**回调解出的凭证**换取最终凭据。
 *
 * 两条分支：
 * 1. 有 `refreshToken` → `ExchangeToken` 换新 access（并**轮换** refreshToken）；
 * 2. 无 `refreshToken` → 直接用 `userJwt.Token` 兜底，不走 ExchangeToken。
 *
 * 随后调 `GetUserInfo` 补齐 uid / nickname / enterpriseId；**失败不阻塞**
 * （回退用回调 `userInfo` 的值）。
 */
export async function exchangeTraeCallback(
	callback: TraeCallbackInfo,
	session: { machineId: string; deviceId: string },
	fetcher: typeof fetch = fetch,
	nowMs: number = Date.now(),
): Promise<TraeCredential> {
	let exchange: TraeExchangeResult;
	if (callback.refreshToken.length > 0) {
		// ── 分支 1：ExchangeToken（access + refreshToken 轮换）──
		const exchangeBody = {
			ClientID: TRAE_CLIENT_ID,
			RefreshToken: callback.refreshToken,
			ClientSecret: '-',
			UserID: '',
		};
		const exchangeResp = await fetcher(`${TRAE_OAUTH_HOST}${TRAE_EXCHANGE_PATH}`, {
			method: 'POST',
			headers: traeOAuthHeaders(),
			body: JSON.stringify(exchangeBody),
			signal: AbortSignal.timeout(TRAE_REQUEST_TIMEOUT_MS),
		});
		if (!exchangeResp.ok) {
			const text = await exchangeResp.text().catch(() => '');
			throw new Error(`TRAE ExchangeToken 失败（HTTP ${exchangeResp.status}）：${text.slice(0, 200)}`);
		}
		const parsed = parseTraeExchangeResponse(await exchangeResp.json() as Record<string, unknown>);
		if (parsed === undefined) {throw new Error('TRAE ExchangeToken 响应缺少 Token');}
		exchange = parsed;
	} else {
		// ── 分支 2：无 refreshToken，直接用 userJwt.Token 兜底 ──
		exchange = {
			accessToken: callback.accessToken,
			refreshToken: '',
			tokenExpireAt: 0,
			tokenExpireDuration: 0,
			refreshExpireAt: 0,
		};
	}

	// GetUserInfo 补齐信息；失败不阻塞（回退回调 userInfo）。
	let userInfo: TraeUserInfoResult = {
		uid: callback.uid,
		screenName: callback.nickname,
		enterpriseId: callback.enterpriseId,
		// ⚠️ 回调的 `userInfo` 参数**不含**脱敏手机号 / 邮箱，它们只在
		// `GetUserInfo` 响应里 —— 故这里回退空串，由下面的分支补上。
		phone: '',
		email: '',
	};
	try {
		const uHeaders = traeOAuthHeaders();
		uHeaders['X-Cloudide-Token'] = exchange.accessToken;
		const userInfoResp = await fetcher(`${TRAE_OAUTH_HOST}${TRAE_USER_INFO_PATH}`, {
			method: 'POST',
			headers: uHeaders,
			body: JSON.stringify({ ReqSource: 'IDE', IDEVersion: TRAE_IDE_VERSION }),
			signal: AbortSignal.timeout(TRAE_REQUEST_TIMEOUT_MS),
		});
		if (userInfoResp.ok) {
			const fetched = parseTraeUserInfoResponse(await userInfoResp.json() as Record<string, unknown>);
			if (fetched !== undefined) {
				userInfo = {
					uid: fetched.uid,
					screenName: fetched.screenName.length > 0 ? fetched.screenName : userInfo.screenName,
					enterpriseId: fetched.enterpriseId.length > 0 ? fetched.enterpriseId : userInfo.enterpriseId,
					phone: fetched.phone,
					email: fetched.email,
				};
			}
		}
	} catch { /* 容错：沿用回调 userInfo */ }

	if (userInfo.uid.length === 0) {
		throw new Error('TRAE 未能确定 uid（回调 userInfo 与 GetUserInfo 均为空）');
	}
	if (exchange.accessToken.length === 0) {
		throw new Error('TRAE 换 token 后没有 accessToken');
	}

	return buildTraeCredential(exchange, userInfo, session, nowMs);
}

// ── 回调服务器 ──

/**
 * 在 `port` 上启动 server，**把启动期的 listen 失败转成 Promise reject**。
 *
 * ## 为什么必须单独封装（真实缺陷）
 *
 * Node 的 `server.listen()` 失败（最典型的是 `EADDRINUSE`）是**通过 `'error'`
 * 事件异步抛出**的，它不属于任何 Promise 链 —— `await` 一个内部调用 `listen()`
 * 的 Promise **捕获不到**这个错误。
 *
 * 若不给 `'error'` 注册处理器，该事件会成为**进程级 unhandled error**，
 * 直接终止整个宿主进程（用户看到的是整堆栈 + 进程退出，而不是一条可读错误）。
 *
 * 修法：在 `listen()` **之前**注册 `'error'`，把首个错误 reject 出去。
 * 启动成功后把一次性处理器**降级为常驻监听**：运行期仍可能出现 `'error'`，
 * 届时没有监听者会再次变成进程级崩溃。
 */
function listenOrReject(server: Server, port: number): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		let settled = false;
		const onListenError = (error: Error): void => {
			if (settled) {return;}
			settled = true;
			reject(error);
		};
		// 必须**先**注册 'error' 再 listen。
		server.once('error', onListenError);
		// 绑定 **127.0.0.1** 而不是 `::`/`0.0.0.0`：这是本地 OAuth 回调服务器，
		// 只应接受本机浏览器的重定向。绑定所有网卡会让同局域网的其它机器也能
		// 向该端口投递伪造的回调，把攻击者的 token 写进用户凭据。
		server.listen(port, '127.0.0.1', () => {
			settled = true;
			server.removeListener('error', onListenError);
			server.on('error', () => { /* 运行期错误：吞掉以免崩进程，由上层超时兜底 */ });
			const address = server.address();
			resolve(typeof address === 'object' && address !== null ? address.port : port);
		});
	});
}

/**
 * 启动回调服务器：优先用 `preferredPort`，被占用时回退到系统分配的随机端口。
 *
 * ## 为什么要回退（而非直接报错）
 *
 * TRAE 的回调地址是**由我们构造并随登录 URL 一起发给服务端**的，服务端会原样
 * 回跳 —— 因此端口不固定也能工作。而固定的 18080 极易被别的程序占用，
 * 直接失败会让「登录」功能在那种机器上完全不可用。
 */
async function listenWithFallback(server: Server, preferredPort: number): Promise<number> {
	try {
		return await listenOrReject(server, preferredPort);
	} catch (error) {
		// 仅在「端口被占用」这类可恢复的启动错误上回退；其它错误（如权限不足
		// 绑定低端口）重试也无意义，直接冒泡。
		const code = (error as { code?: string }).code;
		if (code !== 'EADDRINUSE' && code !== 'EACCES') {throw error;}
		return await listenOrReject(server, 0);
	}
}

/** 一次登录的结果。 */
export interface TraeLoginResult {
	/** 可持久化的凭据 JSON 字符串。 */
	access: string;
	/** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
	expires: number;
	/** 打开的登录 URL。 */
	loginUrl: string;
	/** 凭据是否携带 refresh_token。 */
	refreshable: boolean;
}

/**
 * 运行完整登录流程：起回调服务器 → 打开登录 URL → 等待回调 → 换凭据 → 落库。
 *
 * 阻塞语义：等用户完成授权后才返回。
 */
export async function loginTrae(
	secrets: vscode.SecretStorage,
	secretKey: string,
	token: vscode.CancellationToken,
): Promise<void> {
	const machineId = generateMachineId();
	const deviceId = generateDeviceId();
	const server = createServer();

	let resultTimer: ReturnType<typeof setTimeout> | undefined;
	let loginUrl = '';

	const resultPromise = new Promise<TraeLoginResult>((resolve, reject) => {
		resultTimer = setTimeout(() => {
			server.close();
			reject(new Error('TRAE 登录超时'));
		}, TRAE_LOGIN_TIMEOUT_MS);
		// 不让登录超时定时器**独占事件循环**：它只是兜底窗口，不该阻止进程退出。
		resultTimer.unref?.();

		server.on('request', (req, res) => {
			const url = req.url ?? '';
			if (!url.startsWith(TRAE_CALLBACK_PATH)) {
				res.writeHead(404);
				res.end();
				return;
			}

			// ⚠️ TRAE 回调**直接回传 token**，不是 OAuth 的 `?code=` 授权码。
			const parsed = parseTraeCallbackDetailed(url);
			if (!parsed.ok) {
				// ⚠️ **必须落定结果 Promise**：早期实现在 `res.end()` 之后直接
				// return，`result` Promise 既没 resolve 也没 reject —— 前端永远
				// 拿不到结果，界面永久停在「认证中」，与「回调解析错了」的症状
				// 完全一样，但根因是**这里漏了落定**。
				if (resultTimer) {clearTimeout(resultTimer);}
				res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end(`TRAE 登录回调无效：${parsed.reason}`);
				server.close();
				reject(new Error(`TRAE 登录回调无效：${parsed.reason}`));
				return;
			}

			exchangeTraeCallback(parsed.info, { machineId, deviceId })
				.then((credential) => {
					if (resultTimer) {clearTimeout(resultTimer);}
					res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
					res.end(`TRAE 登录成功：${credential.nickname ?? credential.uid}。可以关闭此页面返回 VS Code。`);
					server.close();
					resolve({
						access: JSON.stringify(credential),
						expires: traeCredentialExpiresAtMs(credential) ?? 0,
						loginUrl,
						refreshable: isTraeRefreshable(credential),
					});
				})
				.catch((error: unknown) => {
					if (resultTimer) {clearTimeout(resultTimer);}
					res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
					res.end(`TRAE 登录失败：${error instanceof Error ? error.message : String(error)}`);
					server.close();
					reject(error instanceof Error ? error : new Error(String(error)));
				});
		});
	});
	// 挂空处理器避免「未处理的拒绝」告警（错误仍会传给真正的消费者）。
	resultPromise.catch(() => { /* 见上 */ });

	// ⚠️ 必须 await：`listen` 失败通过 'error' **事件**抛出，不属于 Promise 链，
	// 不 await 会变成进程级 unhandled error 而崩掉宿主。
	let actualPort: number;
	try {
		actualPort = await listenWithFallback(server, TRAE_CALLBACK_PORT);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`TRAE 回调端口无法监听（${reason}）；端口可能已被其它程序占用，请释放后重试。`);
	}

	// ── 监听成功后才构造登录 URL：回调地址必须写**实际**端口 ──
	const callbackUrl = `http://127.0.0.1:${actualPort}${TRAE_CALLBACK_PATH}`;
	loginUrl = buildTraeLoginURL(machineId, deviceId, callbackUrl);

	await vscode.env.openExternal(vscode.Uri.parse(loginUrl));

	// 取消时关掉服务器并落定 Promise，避免调用方永远挂起。
	const cancellation = token.onCancellationRequested(() => {
		if (resultTimer) {clearTimeout(resultTimer);}
		server.close();
	});
	try {
		const result = await resultPromise;
		await secrets.store(secretKey, result.access);
	} finally {
		cancellation.dispose();
		server.close();
	}
}

// ── 凭据读取与续期 ──

/** 解析 SecretStorage 里的凭据；缺失或损坏时返回 undefined。 */
export async function readTraeCredential(
	secrets: vscode.SecretStorage,
	secretKey: string,
): Promise<TraeCredential | undefined> {
	const value = await secrets.get(secretKey);
	if (value === undefined) {return undefined;}
	let credential: TraeCredential;
	try {
		credential = JSON.parse(value) as TraeCredential;
	} catch {
		throw new Error('TRAE 凭据格式无效，请重新登录');
	}
	if (typeof credential.access_token !== 'string' || credential.access_token.length === 0) {
		throw new Error('TRAE 凭据缺少访问令牌，请重新登录');
	}
	return credential;
}

/** 续期被后端判定为终态（refresh_token 失效）时抛出的错误。 */
export class TraeRefreshTokenExpiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TraeRefreshTokenExpiredError';
	}
}

/**
 * 用 `refresh_token` 换新凭据（ExchangeToken）。
 *
 * 终态判定（三条独立依据，任一成立即需重新登录）：
 * - HTTP 401/403（状态码最权威）；
 * - 分类为 `session-dead`；
 * - 拿到了 2xx、响应体也是 JSON，却**没有** accessToken —— 这不是瞬时故障，
 *   重试一万次也不会有 token。
 *
 * ⚠️ 传输层失败**不能**判为终态 —— 网络抖动不该让用户重新登录。
 */
export async function refreshTraeCredential(
	credential: TraeCredential,
	fetcher: typeof fetch = fetch,
): Promise<TraeCredential> {
	const host = credential.api_host ?? TRAE_OAUTH_HOST;
	const exchangeBody = {
		ClientID: TRAE_CLIENT_ID,
		RefreshToken: credential.refresh_token,
		ClientSecret: '-',
		UserID: '',
	};
	let response: Response;
	try {
		response = await fetcher(`${host}${TRAE_EXCHANGE_PATH}`, {
			method: 'POST',
			headers: traeOAuthHeaders(),
			body: JSON.stringify(exchangeBody),
			signal: AbortSignal.timeout(TRAE_REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		throw new Error(`TRAE 续期网络失败：${error instanceof Error ? error.message : String(error)}`);
	}

	// 取文本再尝试解析（**不要**直接用 response.json()）：凭据失效时网关会返回
	// **HTML 错误页**而不是 JSON，`json()` 抛出的 `Unexpected token '<'` 对用户
	// 毫无意义，也看不出真正原因是凭据过期。
	const text = await response.text().catch(() => '');
	let parsed: Record<string, unknown> | undefined;
	try {
		const candidate = JSON.parse(text) as unknown;
		if (typeof candidate === 'object' && candidate !== null) {
			parsed = candidate as Record<string, unknown>;
		}
	} catch {
		parsed = undefined;
	}

	const exchange = parsed === undefined ? undefined : parseTraeExchangeResponse(parsed);
	if (exchange === undefined || exchange.accessToken.length === 0) {
		const kind = classifyTraeError(response.status, text);
		const noTokenInSuccessResponse = response.ok && parsed !== undefined;
		if (response.status === 401 || response.status === 403
			|| isTraeTerminalError(kind) || noTokenInSuccessResponse) {
			throw new TraeRefreshTokenExpiredError('TRAE refresh_token 已失效，请重新登录');
		}
		throw new Error(`TRAE 续期失败（HTTP ${response.status}）：${text.slice(0, 200)}`);
	}
	return applyTraeRefresh(credential, exchange);
}

/**
 * 读取凭据并在**即将过期**时静默续期，返回可用的最新凭据。
 *
 * 与其他 provider 一致：留 60 秒余量，避免刚判为有效、发请求时已过期。
 */
export async function resolveTraeCredential(
	secrets: vscode.SecretStorage,
	secretKey: string,
): Promise<TraeCredential | undefined> {
	let credential = await readTraeCredential(secrets, secretKey);
	if (credential === undefined) {return undefined;}
	const expiresAt = traeCredentialExpiresAtMs(credential);
	const soon = expiresAt !== undefined && expiresAt <= Date.now() + 60_000;
	if (!soon || !isTraeRefreshable(credential)) {return credential;}
	credential = await refreshTraeCredential(credential);
	await secrets.store(secretKey, JSON.stringify(credential));
	return credential;
}

/**
 * 拉取远端模型目录（`batch_get_detail_param`）。
 *
 * 失败时**抛错**（由 provider 捕获后回退到内置兜底表）—— 目录拉取失败不该让
 * 整个模型选择器不可用，但也不该静默吞掉原因。
 */
export async function fetchTraeModels(
	credential: TraeCredential,
	fetcher: typeof fetch = fetch,
): Promise<unknown> {
	const bodyObj = {
		functions: [...TRAE_QUERY_FUNCTIONS],
		agent_type: '',
		current_config_info: { config_name: '', is_custom_model: false },
		mode_type: 0,
		access_type: 0,
		ab_force_vids: '',
		ab_autotest_advanced_mode: 0,
		show_custom_model: true,
	};
	const url = `${TRAE_AGENT_HOST}${TRAE_BATCH_MODELS_PATH}`;
	console.log('[TRAE] fetchTraeModels: POST', url, 'functions=', TRAE_QUERY_FUNCTIONS.length);
	const response = await fetcher(url, {
		method: 'POST',
		headers: traeSOLOHeaders(credential, false),
		body: JSON.stringify(bodyObj),
		signal: AbortSignal.timeout(TRAE_REQUEST_TIMEOUT_MS),
	});
	console.log('[TRAE] fetchTraeModels: HTTP', response.status, response.statusText);
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		console.warn('[TRAE] fetchTraeModels: 非 2xx，响应体：', text.slice(0, 1000));
		throw new Error(`${SERVER_ERROR_PREFIX}（HTTP ${response.status}）`);
	}
	return await response.json() as unknown;
}
