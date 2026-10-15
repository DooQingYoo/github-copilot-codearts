// OpenRouter 的凭据（API Key）存取。
//
// ⚠️ 与另外三家**根本不同**：OpenRouter **没有浏览器登录流程** —— 不走设备码、
// 不走本地回调、也不需要伪装成某个 IDE 客户端。用户在 openrouter.ai 上创建一个
// API Key 贴进来即可。所以这里没有 `refresh`，也没有"过期时间"：
// Key 是否还有效只能靠上游的 401 暴露出来。
//
// ⚠️ 保存前做一次**自检**（`GET /key`）：粘错 key 是最常见的手误，
// 早失败一次好过在第一次对话时才报 401（那时用户已经在等回复了）。

import * as vscode from 'vscode';
import {
	OPENROUTER_KEY_URL,
	OPENROUTER_REQUEST_TIMEOUT_MS,
	isOpenRouterAuthStatus,
	isOpenRouterKeyShape,
	parseOpenRouterKeyInfo,
} from './openrouter';

/** OpenRouter 凭据。 */
export interface OpenRouterCredential {
	/** API Key（`Authorization: Bearer <api_key>`）。 */
	api_key: string;
	/** 上游 `GET /key` 返回的 key 名称（仅用于界面展示）。 */
	label?: string;
	/** 保存时间（ISO 字符串）。 */
	saved_at?: string;
}

/**
 * 读取凭据；没有则返回 undefined。
 *
 * ⚠️ 形状坏掉时**抛错**（而不是当"没登录"）：静默返回 undefined 会让用户
 * 反复点"设置 API Key"也毫无头绪（与另外三家同一口径）。
 */
export async function readOpenRouterCredential(
	secrets: vscode.SecretStorage,
	secretKey: string,
): Promise<OpenRouterCredential | undefined> {
	const value = await secrets.get(secretKey);
	if (value === undefined) {
		return undefined;
	}
	let credential: OpenRouterCredential;
	try {
		credential = JSON.parse(value) as OpenRouterCredential;
	} catch {
		throw new Error('OpenRouter 凭据格式无效，请重新设置 API Key');
	}
	if (typeof credential.api_key !== 'string' || credential.api_key.length === 0) {
		throw new Error('OpenRouter 凭据缺少 API Key，请重新设置');
	}
	return credential;
}

/**
 * 用 `GET /key` 自检 API Key。
 *
 * ⚠️ 区分「key 无效」与「网络不通」：网络故障被判成「key 无效」会让用户
 * 白删一个完好的 key。401/403 才算无效，其余失败如实报错。
 */
export async function verifyOpenRouterKey(apiKey: string): Promise<{ label?: string }> {
	let response: Response;
	try {
		response = await fetch(OPENROUTER_KEY_URL, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(OPENROUTER_REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		throw new Error(`无法连接 OpenRouter 校验 API Key：${error instanceof Error ? error.message : String(error)}`);
	}
	if (isOpenRouterAuthStatus(response.status)) {
		throw new Error(`OpenRouter API Key 无效（HTTP ${response.status}），请确认复制完整，且该 key 在 openrouter.ai/keys 里处于启用状态`);
	}
	if (!response.ok) {
		throw new Error(`OpenRouter 校验 API Key 失败：HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
	}
	const payload: unknown = await response.json().catch(() => undefined);
	return parseOpenRouterKeyInfo(payload);
}

/**
 * 弹出输入框让用户粘贴 API Key，自检通过后保存。
 *
 * 返回 `undefined` 表示用户取消（**不是**错误）。
 */
export async function loginOpenRouter(
	secrets: vscode.SecretStorage,
	secretKey: string,
): Promise<OpenRouterCredential | undefined> {
	const input = await vscode.window.showInputBox({
		title: 'OpenRouter API Key',
		prompt: '粘贴 OpenRouter 的 API Key（在 openrouter.ai/keys 创建）',
		placeHolder: 'sk-or-v1-…',
		password: true,
		ignoreFocusOut: true,
		validateInput: (value) => {
			const trimmed = value.trim();
			if (trimmed.length === 0 || isOpenRouterKeyShape(trimmed)) {
				return undefined;
			}
			return 'API Key 看起来不完整（应为不含空白的较长字符串）';
		},
	});
	if (input === undefined) {
		return undefined;
	}
	const apiKey = input.trim();
	if (!isOpenRouterKeyShape(apiKey)) {
		throw new Error('OpenRouter API Key 形状无效（应为不含空白的较长字符串）');
	}
	const info = await verifyOpenRouterKey(apiKey);
	const credential: OpenRouterCredential = {
		api_key: apiKey,
		...(info.label === undefined ? {} : { label: info.label }),
		saved_at: new Date().toISOString(),
	};
	await secrets.store(secretKey, JSON.stringify(credential));
	return credential;
}

/** 删除凭据（登出）。 */
export async function clearOpenRouterCredential(
	secrets: vscode.SecretStorage,
	secretKey: string,
): Promise<void> {
	await secrets.delete(secretKey);
}
