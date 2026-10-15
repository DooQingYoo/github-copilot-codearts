// TRAE 上游错误分类。
//
// 移植自 `deepseek-harness-codearts/src/trae-errors.ts`，但**只保留本扩展需要的
// 部分**：本扩展是单凭据、不做账号轮换，故不移植「换号 / 冷却时长」那套状态机
// （与 Qoder 中国版的移植口径一致）。
//
// 保留分类的意义在于**终态判定**：`session-dead` 表示 refresh_token 已失效，
// 重试无意义，必须提示用户重新登录；其余类别（网络抖动、5xx、429）都是可重试的。

/** TRAE 上游错误类别。 */
export type TraeErrorKind =
	/** 成功（HTTP < 400）。 */
	| 'none'
	/** Plan 权益不足（1005）。 */
	| 'hard-plan'
	/** 429 软限流或频率超限（4011）。 */
	| 'soft-rate'
	/** 会话终止：refresh_token / access_token 失效 → 需重新登录。 */
	| 'session-dead'
	/** 配额超限（4008：ide_credits 耗尽）→ 等每日重置或签到。 */
	| 'quota-exceeded'
	/** 404。 */
	| 'not-found'
	/** 5xx 上游故障。 */
	| 'server'
	/** 其他 4xx / 业务错误。 */
	| 'client';

/** 会话死亡标记。 */
const SESSION_DEAD_MARKERS: readonly string[] = [
	'login', 'token 失效', 'token invalid', 'session', 'unauthorized', '401',
];

/** Plan 权益不足标记。 */
const PLAN_LIMIT_MARKERS: readonly string[] = ['"code":1005', '1005'];

/** 配额超限标记（ide_credits 耗尽）。 */
const QUOTA_EXCEEDED_MARKERS: readonly string[] = ['4008', '"code":4008', 'quota', 'exceeded the quota'];

/**
 * 按 HTTP 状态码 + 响应体判定错误类别。
 *
 * 判定顺序（**不可重排**）：
 *
 * 1. body 含 1005 + plan → `hard-plan`
 * 2. body 含 4008 → `quota-exceeded`（**先于 4011**，见下）
 * 3. body 含 4011 → `soft-rate`
 * 4. HTTP 401 → `session-dead`
 * 5. HTTP 429 → `soft-rate`
 * 6. HTTP 404 → `not-found`
 * 7. >= 500 → `server`
 * 8. >= 400 → `client`
 * 9. 否则 `none`
 *
 * ⚠️ **第 2 条必须排在 4011 之前**：两者可能同时出现在一个响应体里（网关把多个
 * 错误码拼在 msg 中）。让较轻的类别抢先命中，会让一个已耗尽额度的账号被反复
 * 重试，用户看到的却是「稍后再试」。更严重的分类必须优先。
 *
 * @param status HTTP 状态码
 * @param body 响应体原文（JSON 或纯文本均可，只做子串匹配）
 */
export function classifyTraeError(status: number, body: string): TraeErrorKind {
	const lower = body.toLowerCase();

	// 1. Plan 权益不足
	for (const marker of PLAN_LIMIT_MARKERS) {
		if (body.includes(marker) && lower.includes('plan')) {return 'hard-plan';}
	}

	// 2. 配额超限（4008，ide_credits 耗尽）
	for (const marker of QUOTA_EXCEEDED_MARKERS) {
		if (body.includes(marker)) {return 'quota-exceeded';}
	}

	// 3. 频率超限（4011）
	if (body.includes('4011') || body.includes('"code":4011')) {return 'soft-rate';}

	// 4. Session 失效（401 恒归此类：状态码比报文措辞权威）
	if (status === 401) {return 'session-dead';}

	// 5. 429 软限流
	if (status === 429) {return 'soft-rate';}

	// 6. 404
	if (status === 404) {return 'not-found';}

	// 7. 5xx 上游故障
	if (status >= 500) {return 'server';}

	// 8. 其他 4xx
	if (status >= 400) {return 'client';}

	return 'none';
}

/**
 * 该类别是否属于终态（重试无意义，只能重新登录）。
 *
 * ⚠️ 只有 `session-dead` 是终态。`quota-exceeded` **不是** —— 额度会随每日
 * 重置恢复，把它判成终态会让用户被无谓地要求重新登录。
 */
export function isTraeTerminalError(kind: TraeErrorKind): boolean {
	return kind === 'session-dead';
}

/** 该类别是否属于额度类（用于给出可操作的提示文案）。 */
export function isTraeQuotaError(kind: TraeErrorKind): boolean {
	return kind === 'quota-exceeded' || kind === 'hard-plan';
}
