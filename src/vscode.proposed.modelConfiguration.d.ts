/*---------------------------------------------------------------------------------------------
 * 本文件为**本地类型补充**，不是 VS Code 官方产物。
 *
 * 背景：`@types/vscode@1.140.0` 尚未包含「模型级配置」（model configuration）相关的字段，
 * 而 VS Code 1.141+ / Copilot Chat 0.48+ **已经支持**：
 *
 * - `LanguageModelChatInformation.configurationSchema`：声明该模型可配置项的 JSON Schema；
 * - `ProvideLanguageModelChatResponseOptions.modelConfiguration`：用户选定的配置值。
 *
 * 有了它，provider 才能把「思考强度」这类参数暴露到模型选择器里让用户切换
 * （设置项 `group: 'navigation'` 会把它作为主要操作展示）。
 *
 * ⚠️ 这些字段属较新 API 面。此声明只让 TypeScript 认字段与形状；
 * 运行时若 VS Code 不读 `configurationSchema`，则用户看不到该配置项
 * （**降级为「不可配置」而非报错**），调用点仍须对 `modelConfiguration` 缺失兜底。
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {
	/**
	 * 描述单个模型可配置项的 JSON Schema（简化为本仓库用到的子集）。
	 */
	export interface LanguageModelConfigurationSchema {
		readonly properties?: {
			readonly [key: string]: {
				readonly type?: string;
				readonly title?: string;
				readonly description?: string;
				/** 可选值枚举。 */
				readonly enum?: readonly string[];
				/** 与 `enum` 等长、同序的展示标签。 */
				readonly enumItemLabels?: readonly string[];
				/** 与 `enum` 等长、同序的说明。 */
				readonly enumDescriptions?: readonly string[];
				/** 默认值。 */
				readonly default?: unknown;
				/** `'navigation'` 表示该配置作为模型选择器里的主要操作展示。 */
				readonly group?: string;
			};
		};
	}

	export interface LanguageModelChatInformation {
		/** 该模型的可配置项声明；未声明则模型不可配置。 */
		readonly configurationSchema?: LanguageModelConfigurationSchema;
	}

	export interface ProvideLanguageModelChatResponseOptions {
		/**
		 * 用户为该模型选定的配置值（键与 `configurationSchema.properties` 对应），
		 * 已合并 schema 默认值与用户覆盖。
		 */
		readonly modelConfiguration?: { readonly [key: string]: unknown };
	}
}
