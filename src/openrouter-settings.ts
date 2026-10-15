// OpenRouter 的「上游供应商」绑定：**设置**存取 + 纯函数。
//
// ## 为什么走 VS Code 设置，而不是模型选择器里的配置项
//
// ⚠️ 这是个**查过源码才敢下的结论**，不要再试图把它塞进模型选择器：
//
// VS Code 的模型选择器**只有两个配置槽位**，且语义是固定的：
//
// | 常量 | 值 | 语义 |
// |---|---|---|
// | `MODEL_CONFIG_GROUP_EFFORT` | `'navigation'` | 思考强度 / Auto 的路由档 |
// | `MODEL_CONFIG_GROUP_CONTEXT` | `'tokens'` | 上下文窗口 |
//
// 三处源码互相印证（`microsoft/vscode`）：
//
// 1. `modelPickerModelConfig.ts` 的编排只遍历这两个 group
//    （`for (const group of [MODEL_CONFIG_GROUP_EFFORT, MODEL_CONFIG_GROUP_CONTEXT])`），
//    ⇒ **任何自定义 group 名都不会被读取**（等于没声明）；
// 2. `modelPickerHover.ts`：`SUPPORTED_CONFIG_GROUPS = [EFFORT, CONTEXT]`（显式白名单）；
// 3. `modelPickerCard.ts`：`_groupControls` 按这两个 group **各建一个控件**
//    ⇒ 一个模型最多两个配置控件。
//
// 而且同一 group 内**只取一个属性**，`getModelConfigProperty()` 的注释原话是
// "Selects a property by explicit alias precedence, then schema order for unknown keys" ——
// `navigation` 的别名表是 `['tier','autoTier','thinkingLevel','reasoningEffort']`，
// 我们的 `reasoningEffort` 命中别名后，**同 group 里再声明的 `provider` 永远取不到**。
//
// ⚠️ **借用 `tokens` 槽位同样不可接受**（曾经考虑过）：`modelPickerCard.ts` 用
// `isExtendedContext(context)`（判据 = `值 === enum[最后一项]`）决定是否按
// **扩展上下文定价**展示价格；我们占了那个槽、用户又选中了枚举最后一项时，
// VS Code 会显示**错误的价格**。宁可不在选择器里选，也不能显示错的价。
//
// ⇒ 结论：用**本插件自己的命令** + **VS Code 设置**。好处有三：
// ① 模型选择器列表保持简短（用户明确要求）；② 绑定关系在 `settings.json` 里可见、
// 可手改、还能随 Settings Sync 走；③ 完全建立在有文档的公开契约上。

import * as vscode from 'vscode';

/** 设置节名（`contributes.configuration` 里的节）。 */
export const OPENROUTER_SETTINGS_SECTION = 'github-copilot-codearts.openrouter';
/** 设置项名：`模型 id → 上游 slug` 映射。 */
export const OPENROUTER_PINNED_PROVIDERS_SETTING = 'pinnedProviders';

/**
 * 归一化设置值：只保留「非空字符串键 → 非空字符串值」，其余一律丢弃。
 *
 * ⚠️ 设置是**用户手改的输入**（还可能是别处同步来的脏数据）：类型不对、值为 null、
 * 空串都当「没绑」。丢了不报错是**有意**的 —— 一个坏条目不应该让整个模型列表不可用。
 */
export function normalizePinnedProviders(value: unknown): Record<string, string> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return {};
	}
	const output: Record<string, string> = {};
	for (const [modelId, slug] of Object.entries(value as Record<string, unknown>)) {
		if (modelId.length > 0 && typeof slug === 'string' && slug.trim().length > 0) {
			output[modelId] = slug.trim();
		}
	}
	return output;
}

/**
 * 计算写入后的新映射（**纯函数**）。
 *
 * `slug` 为空 / `'auto'` ⇒ **删除该键**（而不是写一个 `auto` 值）：
 * 这样 settings.json 里只留下真正的绑定，用户一眼能看出「哪些模型被锁了」。
 */
export function withPinnedProvider(
	map: Record<string, string>,
	modelId: string,
	slug: string | undefined,
): Record<string, string> {
	const next = { ...map };
	if (slug === undefined || slug.trim().length === 0 || slug === 'auto') {
		delete next[modelId];
	} else {
		next[modelId] = slug.trim();
	}
	return next;
}

/** 从 VS Code 设置读绑定表（纯读取，无副作用）。 */
export function readPinnedProviders(): Record<string, string> {
	return normalizePinnedProviders(
		vscode.workspace.getConfiguration(OPENROUTER_SETTINGS_SECTION)
			.get(OPENROUTER_PINNED_PROVIDERS_SETTING),
	);
}

/**
 * 写绑定表（**只由命令调用**）。
 *
 * ⚠️ 表为空时写 `undefined`（把设置项整个移除）而不是写一个空对象：
 * 空对象会永远留在用户的 settings.json 里当噪声。
 * ⚠️ 目标一律 `Global`（用户级）：绑定是「我的偏好」，不该被某个工作区覆盖掉。
 */
export async function savePinnedProviders(map: Record<string, string>): Promise<void> {
	const configuration = vscode.workspace.getConfiguration(OPENROUTER_SETTINGS_SECTION);
	await configuration.update(
		OPENROUTER_PINNED_PROVIDERS_SETTING,
		Object.keys(map).length === 0 ? undefined : map,
		vscode.ConfigurationTarget.Global,
	);
}
