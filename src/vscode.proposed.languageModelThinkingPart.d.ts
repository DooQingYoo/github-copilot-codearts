/*---------------------------------------------------------------------------------------------
 * 本文件为**本地类型补充**，不是 VS Code 官方产物。
 *
 * 背景：`@types/vscode@1.140.0` 尚未包含 `LanguageModelThinkingPart`，而 VS Code 运行时
 * （1.141+ / Copilot Chat 0.48+）**已经暴露该类**，且 Copilot 会把它渲染成「思考过程」块。
 *
 * ⚠️ 该类属于 proposed API 面。此声明只让 TypeScript 认这个类名与构造签名；
 * 运行时若 `vscode.LanguageModelThinkingPart` 不存在，调用点必须自行兜底
 * （见 `codebuddy-provider.ts` / `qoder-cn-provider.ts` 的 `reportThinking`），
 * 不能假定一定可用。
 *
 * 与 `opencode-go-copilot` 项目的做法一致：以本地 `.d.ts` 补类型 + 运行时探测。
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {
	/**
	 * 承载模型内部推理（thinking / reasoning）内容的响应部件。
	 * 思考 token 通常在正式回复之前流出。
	 */
	export class LanguageModelThinkingPart {
		/** 思考文本（可分段）。 */
		value: string | string[];

		/** 可选：该思考序列的唯一标识（常在思考流结束时给出）。 */
		id?: string;

		/** 可选：随该思考序列携带的元数据。 */
		metadata?: { readonly [key: string]: unknown };

		/**
		 * @param value 思考文本内容。
		 * @param id 可选：该思考序列的唯一标识。
		 * @param metadata 可选：元数据。
		 */
		constructor(value: string | string[], id?: string, metadata?: { readonly [key: string]: unknown });
	}
}
