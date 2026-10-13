import * as vscode from 'vscode';

const API = 'https://copilot.tencent.com';
const API_DOMAIN = 'copilot.tencent.com';
const USER_AGENT = 'CodeBuddyIDE/1.106.1';
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 1_000;

export interface CodeBuddyCredential {
	access_token: string;
	refresh_token: string;
	expires_at?: string;
	refresh_expires_at?: string;
	token_type?: string;
	scope?: string;
	domain?: string;
	user_id?: string;
	nickname?: string;
	enterprise_id?: string;
	account_type?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string {
	if (!isRecord(value)) {return '';}
	const field = value[key];
	return typeof field === 'string' || typeof field === 'number' ? String(field) : '';
}

function dataOf(value: unknown): unknown {
	return isRecord(value) && value.data !== null ? value.data : undefined;
}

async function requestJson(url: string, init: RequestInit, token: vscode.CancellationToken): Promise<unknown> {
	const controller = new AbortController();
	const cancellation = token.onCancellationRequested(() => controller.abort());
	try {
		const response = await fetch(url, {
			...init,
			signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
		});
		const body: unknown = await response.json().catch(() => undefined);
		if (!response.ok) {
			const message = stringField(body, 'message') || `HTTP ${response.status}`;
			throw new Error(`HTTP ${response.status}: ${message}`);
		}
		return body;
	} finally {
		cancellation.dispose();
	}
}

function pause(ms: number, token: vscode.CancellationToken): Promise<void> {
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

async function poll<T>(
	url: string,
	init: RequestInit,
	ready: (body: unknown) => T | undefined,
	token: vscode.CancellationToken,
): Promise<T> {
	const deadline = Date.now() + LOGIN_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (token.isCancellationRequested) {throw new Error('登录已取消');}
		try {
			const body = await requestJson(url, init, token);
			const result = ready(body);
			if (result !== undefined) {return result;}
			const code = stringField(body, 'code');
			if (code !== '' && code !== '11217' && code !== '12151') {
				throw new Error(stringField(body, 'message') || `登录服务返回错误码 ${code}`);
			}
		} catch (error) {
			if (token.isCancellationRequested) {throw new Error('登录已取消');}
			if (error instanceof Error && (/^HTTP \d+/.test(error.message) || error.message.startsWith('登录服务返回错误码'))) {throw error;}
		}
		await pause(POLL_INTERVAL_MS, token);
	}
	throw new Error('CodeBuddy 登录等待超时，请重新发起登录');
}

function expiresAtOf(tokenValue: string, expiresIn: string): string {
	const seconds = Number(expiresIn);
	if (Number.isFinite(seconds) && seconds > 0) {
		try {
			const payload = JSON.parse(Buffer.from(tokenValue.split('.')[1] ?? '', 'base64url').toString('utf8')) as { iat?: unknown };
			const issuedAt = typeof payload.iat === 'number' ? payload.iat * 1000 : Date.now();
			return String(issuedAt + seconds * 1000);
		} catch {
			return String(Date.now() + seconds * 1000);
		}
	}
	return '';
}

function tokenData(value: unknown): Omit<CodeBuddyCredential, 'user_id' | 'nickname' | 'enterprise_id' | 'account_type'> {
	const data = dataOf(value);
	const accessToken = stringField(data, 'accessToken');
	if (accessToken.length === 0) {throw new Error('CodeBuddy 响应未包含 access token');}
	return {
		access_token: accessToken,
		refresh_token: stringField(data, 'refreshToken'),
		expires_at: stringField(data, 'expiresAt') || expiresAtOf(accessToken, stringField(data, 'expiresIn')),
		refresh_expires_at: stringField(data, 'refreshExpiresAt') || expiresAtOf(accessToken, stringField(data, 'refreshExpiresIn')),
		token_type: stringField(data, 'tokenType') || 'Bearer',
		scope: stringField(data, 'scope'),
		domain: stringField(data, 'domain'),
	};
}

export async function loginCodeBuddy(
	secrets: vscode.SecretStorage,
	secretKey: string,
	token: vscode.CancellationToken,
): Promise<void> {
	const stateBody = await requestJson(`${API}/v2/plugin/auth/state?platform=ide`, {
		method: 'POST',
		headers: {
			'X-Domain': API_DOMAIN,
			'X-No-Authorization': 'true',
			'X-No-User-Id': 'true',
			'X-No-Enterprise-Id': 'true',
			'X-No-Department-Info': 'true',
			'User-Agent': USER_AGENT,
		},
	}, token);
	const data = dataOf(stateBody);
	const state = stringField(data, 'state');
	const authUrl = stringField(data, 'authUrl');
	if (state.length === 0 || authUrl.length === 0) {throw new Error('CodeBuddy 登录服务未返回授权地址');}
	await vscode.env.openExternal(vscode.Uri.parse(authUrl));

	const noAuthHeaders = { 'X-No-Authorization': 'true', 'User-Agent': USER_AGENT };
	const tokenUrl = `${API}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`;
	const tokens = await poll(tokenUrl, { headers: noAuthHeaders }, (body) => {
		if (stringField(body, 'code') === '11217') {return undefined;}
		const data = dataOf(body);
		if (!isRecord(data) || stringField(data, 'accessToken') === '') {return undefined;}
		return tokenData(body);
	}, token);

	const accountUrl = `${API}/v2/plugin/login/account?state=${encodeURIComponent(state)}`;
	const account = await poll(accountUrl, {
		headers: {
			...noAuthHeaders,
			'X-Domain': tokens.domain || API_DOMAIN,
			Authorization: `Bearer ${tokens.access_token}`,
			'X-No-User-Id': 'true',
			'X-No-Enterprise-Id': 'true',
		},
	}, (body) => {
		if (stringField(body, 'code') === '12151') {return undefined;}
		const data = dataOf(body);
		if (!isRecord(data)) {return undefined;}
		return {
			user_id: stringField(data, 'uid'),
			nickname: stringField(data, 'nickname'),
			enterprise_id: stringField(data, 'enterpriseId'),
			account_type: stringField(data, 'type') || 'personal',
		};
	}, token);
	await secrets.store(secretKey, JSON.stringify({ ...tokens, ...account } satisfies CodeBuddyCredential));
}

export async function readCodeBuddyCredential(
	secrets: vscode.SecretStorage,
	secretKey: string,
	token: vscode.CancellationToken,
): Promise<CodeBuddyCredential | undefined> {
	const value = await secrets.get(secretKey);
	if (value === undefined) {return undefined;}
	let credential: CodeBuddyCredential;
	try {
		credential = JSON.parse(value) as CodeBuddyCredential;
	} catch {
		throw new Error('CodeBuddy 凭据格式无效，请重新登录');
	}
	if (typeof credential.access_token !== 'string' || credential.access_token.length === 0) {
		throw new Error('CodeBuddy 凭据缺少访问令牌，请重新登录');
	}
	const expiresAt = credentialExpiresAtMs(credential);
	if (!credential.refresh_token || !Number.isFinite(expiresAt) || expiresAt > Date.now() + 60_000) {return credential;}

	const response = await requestJson(`${API}/v2/plugin/auth/token/refresh`, {
		method: 'POST',
		headers: {
			'X-Domain': credential.domain || API_DOMAIN,
			'User-Agent': USER_AGENT,
			Authorization: `Bearer ${credential.access_token}`,
			'X-Refresh-Token': credential.refresh_token,
			'X-Auth-Refresh-Source': 'ide-main',
		},
	}, token);
	const refreshed = tokenData(response);
	credential = {
		...credential,
		...refreshed,
		refresh_token: refreshed.refresh_token || credential.refresh_token,
	};
	await secrets.store(secretKey, JSON.stringify(credential));
	return credential;
}

export function credentialExpiresAtMs(credential: CodeBuddyCredential): number {
	const value = credential.expires_at;
	if (typeof value === 'string' && value.length > 0) {
		if (/^\d+$/.test(value)) {
			const timestamp = Number(value);
			return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
		}
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) {return parsed;}
	}
	try {
		const payload = JSON.parse(Buffer.from(credential.access_token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
		return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : Number.NaN;
	} catch {
		return Number.NaN;
	}
}