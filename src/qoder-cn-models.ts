// Qoder（中国版）模型目录（**实测数据**）。
//
// 来源：从 `deepseek-harness-codearts/src/qoder-product.ts` 的 `QODER_CN_FALLBACK_MODELS`
// 移植（本机 `~/.qoder-cn/.models/{uid}/catalog-v6` 的 `chat` 场景，用国际版 WASM 解密）。
//
// ⚠️ **不能沿用国际版那张表**：CN 独有 `q37fmodel` / `gm51model`；CN **没有**
// `ultimate` / `performance` / `efficient` / `smodel` / `cmodel`；`mmodel` 在 CN 是
// **MiniMax-M2.7**（国际版 M3）。沿用会让菜单出现 CN 端点根本不认的模型。
//
// ⚠️ `id` 是 Qoder 客户端的**真实模型 key**（`qfmodel` 等），且**必须走加密端点**：
// 公开的 `/model/v1/chat/completions` 不认它们（CN 更是直接 503）。

/** 兜底模型目录中的一个条目。 */
export interface QoderCnFallbackModel {
	/** 模型目录 key（如 `qfmodel`）。**加密端点认的就是它**。 */
	id: string;
	/** 展示名（即模型选择器默认名）。 */
	name: string;
	/** 上下文窗口（**总上下文**）。 */
	contextWindow: number;
	/** 是否接受图片输入（远端 `is_vl`）。 */
	supportsImage?: boolean;
	/** 是否支持思考（远端 `is_reasoning`）。 */
	supportsThinking?: boolean;
	/** 是否免费额度模型（远端 `is_free`）。 */
	isFree?: boolean;
	/** 计费倍率（目录 `price_factor`）。**0 是合法值**（免费）。 */
	priceFactor?: number;
	/** 促销前的原价倍率。 */
	originalPriceFactor?: number;
	/** 促销（错峰折扣）。 */
	promotion?: QoderCnPromotion;
	/** 可选思考档位。 */
	efforts?: readonly string[];
	/** 默认思考档位（必须落在 `efforts` 内）。 */
	defaultEffort?: string;
	/** 是否提供「关闭思考」。 */
	supportsDisable?: boolean;
}

/** 错峰折扣（目录 `promotion`）。 */
export interface QoderCnPromotion {
	active: boolean;
	discountFactor?: number;
	beforePromotionPriceFactor?: number;
	windowStart?: string;
	windowEnd?: string;
}

/**
 * 中国版模型目录（**实测**，2026-09-27）。
 *
 * `contextWindow` 取官方档位表 `context_config` 的**最大档**，不是 `max_input_tokens`
 * （两者常自相矛盾，而官方客户端只认档位表）。
 */
export const QODER_CN_FALLBACK_MODELS: readonly QoderCnFallbackModel[] = [
	{ id: 'auto', name: 'Auto', contextWindow: 200_000, supportsImage: true, supportsThinking: true, priceFactor: 0.5 },
	{
		id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true,
		isFree: true, priceFactor: 0.2, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium', supportsDisable: true,
		promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.5, windowStart: '22:00', windowEnd: '08:00' },
	},
	{
		// `priceFactor: 0` 是**免费**，不是缺失。
		id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true,
		isFree: true, priceFactor: 0, originalPriceFactor: 0.1, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium', supportsDisable: true,
	},
	{
		// 没有 `efforts`，只有「关闭思考」。
		id: 'qmodel_latest', name: 'Qwen3.7-Max', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true,
		priceFactor: 0.1, supportsDisable: true,
		promotion: { active: true, discountFactor: 0.2, beforePromotionPriceFactor: 0.5, windowStart: '22:00', windowEnd: '08:00' },
	},
	{
		id: 'qmodel', name: 'Qwen3.7-Plus', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true,
		priceFactor: 0.04, supportsDisable: true,
		promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.1, windowStart: '22:00', windowEnd: '08:00' },
	},
	// CN 独有：Qwen3.7-Flash（目录里没有 `thinking_config` → 不可选档位）。
	{ id: 'q37fmodel', name: 'Qwen3.7-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1 },
	{ id: 'dmodel', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.5, efforts: ['high', 'max'], defaultEffort: 'max', supportsDisable: true },
	// CN 的 `is_reasoning` 为 false，故不声明 supportsThinking。
	{ id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 1_000_000, supportsImage: true, priceFactor: 0.1, efforts: ['high', 'max', 'low'], defaultEffort: 'max', supportsDisable: true },
	{ id: 'gmodel', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.8, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
	{ id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1, efforts: ['high', 'max'], defaultEffort: 'max' },
	// CN 独有：GLM-5.2。
	{ id: 'gm51model', name: 'GLM-5.2', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.6, efforts: ['high', 'max'], defaultEffort: 'max', supportsDisable: true },
	{ id: 'kmodel_latest', name: 'Kimi-K3', contextWindow: 1_000_000, supportsImage: true, priceFactor: 1.4, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
	{ id: 'kmodel', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.8, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
	// 版本是 M2.7（国际版 M3），且 CN 的 `is_vl` 为 false，唯一档位表只有 200K 一档。
	{ id: 'mmodel', name: 'MiniMax-M2.7', contextWindow: 200_000, priceFactor: 0.2 },
];

/**
 * 判断当前是否落在错峰折扣窗口内（本地推算）。
 *
 * 窗口按 **UTC+8** 计（目录 `timezone: Asia/Singapore`），支持跨零点（如 22:00–08:00）。
 */
export function promotionActiveNow(promotion: QoderCnPromotion, now: Date): boolean {
	const { windowStart, windowEnd } = promotion;
	if (windowStart === undefined || windowEnd === undefined) {
		return promotion.active;
	}
	const toMinutes = (hhmm: string): number | undefined => {
		const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
		if (m === null) {
			return undefined;
		}
		const h = Number(m[1]);
		const min = Number(m[2]);
		return h < 24 && min < 60 ? h * 60 + min : undefined;
	};
	const start = toMinutes(windowStart);
	const end = toMinutes(windowEnd);
	if (start === undefined || end === undefined) {
		return promotion.active;
	}
	const utc8 = new Date(now.getTime() + 8 * 3_600_000);
	const minutes = utc8.getUTCHours() * 60 + utc8.getUTCMinutes();
	return start <= end
		? minutes >= start && minutes < end
		: minutes >= start || minutes < end;
}

/**
 * 生成模型选择器里显示的名字（与 TRAE / buddy 统一形态）。
 *
 * ```
 * Qwen3.8-Flash · 免费            ← priceFactor = 0
 * Qwen3.8-Max · x0.5→x0.2        ← 折扣窗口内：原价→折后价
 * Qwen3.8-Max · x0.5             ← 窗口外：只有原价
 * ```
 *
 * ⚠️ **倍率必须写进 `name` 而不是 `description`**：模型切换菜单只渲染 `name`。
 */
export function qoderCnDisplayName(model: QoderCnFallbackModel, now: Date = new Date()): string {
	const promo = model.promotion;
	const before = promo?.beforePromotionPriceFactor;
	const discount = promo?.discountFactor;
	const hasPromo = promo !== undefined && before !== undefined && discount !== undefined;
	const active = hasPromo && promotionActiveNow(promo, now);

	if (model.priceFactor === 0) {
		return `${model.name} · 免费`;
	}
	if (hasPromo && active) {
		const effective = Number((before * discount).toFixed(4));
		return `${model.name} · x${before}→x${effective}`;
	}
	const price = hasPromo ? before : model.priceFactor;
	return price !== undefined ? `${model.name} · x${price}` : model.name;
}

/** 思考档位的中文名（与 Qoder 客户端 i18n 一致）。 */
export const QODER_CN_EFFORT_NAMES: Record<string, string> = {
	none: '关闭思考',
	minimal: '最小',
	low: '低',
	medium: '中',
	high: '高',
	xhigh: '极高',
	max: '最大',
};

/**
 * 该模型可选的思考档位（含「关闭思考」的追加规则）。
 *
 * ⚠️ **「关闭思考」不在目录的 `efforts` 数组里**，由 `supportsDisable` 决定，
 * 故这里在末尾追加 `none`（客户端也是这么做的）。
 */
export function qoderCnEffortsFor(model: QoderCnFallbackModel): string[] {
	const efforts = model.efforts !== undefined ? [...model.efforts] : [];
	if (model.supportsDisable === true && !efforts.includes('none')) {
		efforts.push('none');
	}
	return efforts;
}
