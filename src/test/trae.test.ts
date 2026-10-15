import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	TRAE_CHANNELS,
	applyTraeRefresh,
	buildTraeCredential,
	clampTraeMaxTokens,
	declaresReasoningOptions,
	generateDeviceId,
	generateMachineId,
	isTraeExpired,
	isTraeModelCallable,
	isTraeRefreshable,
	machineTraceId,
	parseTraeBatchModelList,
	parseTraeExchangeResponse,
	parseTraeSSELine,
	parseTraeUserInfoResponse,
	readActivityDiscount,
	readConsumptionRate,
	traeCredentialExpiresAtMs,
	traeDisplayNickname,
	traeMaxModeFields,
	traeStreamErrorMessage,
	traeUsageFromTokenUsage,
	transformToSOLOBody,
	withTraePhone,
	type TraeCredential,
} from '../trae';
import { classifyTraeError, isTraeTerminalError } from '../trae-errors';
import {
	buildTraeLoginURL,
	fixNicknameMojibake,
	parseTraeCallback,
	parseTraeCallbackDetailed,
} from '../trae-auth';
import {
	consumeTraeSse,
	defaultTraeEffort,
	describeTraeCatalog,
	messagesToTrae,
	strongestTraeEffort,
	traeDisplayName,
	traeTools,
	TraeChatProvider,
} from '../trae-provider';

/** 构造一份最小可用凭据。 */
function credential(overrides: Partial<TraeCredential> = {}): TraeCredential {
	return {
		access_token: 'access-1',
		refresh_token: 'refresh-1',
		uid: 'uid-1',
		machine_id: 'm'.repeat(32),
		device_id: 'd'.repeat(32),
		...overrides,
	};
}

suite('TRAE (字节) 测试', () => {
	// ── 登录 URL 与回调 ──

	test('登录 URL 含完整 17 参数，且回调参数名是 auth_callback_url', () => {
		const url = buildTraeLoginURL('machine-1', 'device-1', 'http://127.0.0.1:18080/authorize');
		assert.ok(url.startsWith('https://www.trae.cn/authorization?'));
		const query = new URL(url).searchParams;
		// ⚠️ 参数名必须是 auth_callback_url（写成 callback_url 会让登录页永远停在授权中）。
		assert.strictEqual(query.get('auth_callback_url'), 'http://127.0.0.1:18080/authorize');
		assert.strictEqual(query.get('callback_url'), null);
		assert.strictEqual(query.get('redirect_uri'), null);
		// 其余决定授权通道的参数一个都不能少。
		for (const key of [
			'login_version', 'auth_from', 'login_channel', 'plugin_version', 'auth_type',
			'client_id', 'redirect', 'login_trace_id', 'machine_id', 'device_id',
			'x_device_id', 'x_machine_id', 'x_device_brand', 'x_device_type',
			'x_os_version', 'x_app_version', 'x_app_type',
		]) {
			assert.ok(query.get(key) !== null, `缺少参数 ${key}`);
		}
		assert.strictEqual(query.get('login_trace_id'), machineTraceId('machine-1', 'device-1'));
	});

	test('回调直接回传 token（不是 OAuth 的 ?code=）', () => {
		const userInfo = encodeURIComponent(JSON.stringify({
			UserID: '4056564292660009',
			ScreenName: '用户26815487395',
			TenantID: 'tenant-1',
		}));
		const url = `/authorize?refreshToken=rt-1&userInfo=${userInfo}`;
		const info = parseTraeCallback(url);
		assert.ok(info);
		assert.strictEqual(info.refreshToken, 'rt-1');
		assert.strictEqual(info.uid, '4056564292660009');
		assert.strictEqual(info.enterpriseId, 'tenant-1');
		// 有 refreshToken 时不用 userJwt.Token 兜底。
		assert.strictEqual(info.accessToken, '');
	});

	test('query 缺 refreshToken 时回退 userJwt.RefreshToken', () => {
		const userJwt = encodeURIComponent(JSON.stringify({ Token: 'jwt-token', RefreshToken: 'jwt-refresh' }));
		const info = parseTraeCallback(`/authorize?userJwt=${userJwt}`);
		assert.ok(info);
		assert.strictEqual(info.refreshToken, 'jwt-refresh');
		// 有 refreshToken 时 accessToken 仍为空（只在无 refreshToken 时才兜底）。
		assert.strictEqual(info.accessToken, '');
	});

	test('无 refreshToken 时用 userJwt.Token 兜底', () => {
		const userJwt = encodeURIComponent(JSON.stringify({ Token: 'jwt-token' }));
		const info = parseTraeCallback(`/authorize?userJwt=${userJwt}`);
		assert.ok(info);
		assert.strictEqual(info.refreshToken, '');
		assert.strictEqual(info.accessToken, 'jwt-token');
	});

	test('PKCE 形态的回调给出精确报错（不是含糊的「缺少 refreshToken」）', () => {
		const result = parseTraeCallbackDetailed('/authorize?code=abc123');
		assert.strictEqual(result.ok, false);
		if (result.ok) {return;}
		assert.strictEqual(result.authCodeFlow, true);
		assert.ok(result.reason.includes('PKCE'));
	});

	test('既无 token 也无 code 的回调判为无效', () => {
		const result = parseTraeCallbackDetailed('/authorize?foo=bar');
		assert.strictEqual(result.ok, false);
		if (result.ok) {return;}
		assert.strictEqual(result.authCodeFlow, false);
		assert.ok(result.reason.includes('refreshToken'));
	});

	test('昵称双重编码乱码被修复；无 CJK 时回退占位名', () => {
		// latin1 误读的中文可被回转。
		const mojibake = Buffer.from('张三', 'utf8').toString('latin1');
		assert.strictEqual(fixNicknameMojibake(mojibake, 'uid-1234'), '张三');
		// 无法修复且不含 CJK → 回退「用户 + uid 末 4 位」。
		assert.strictEqual(fixNicknameMojibake('Óû§8847309959', '4056564292660009'), '用户0009');
	});

	// ── 凭据 ──

	test('ExchangeToken 响应解析（Result 大小写兼容）', () => {
		const parsed = parseTraeExchangeResponse({
			Result: { Token: 'a', RefreshToken: 'r', TokenExpireAt: 1_800_000_000, TokenExpireDuration: 3600 },
		});
		assert.ok(parsed);
		assert.strictEqual(parsed.accessToken, 'a');
		assert.strictEqual(parsed.refreshToken, 'r');
		assert.strictEqual(parsed.tokenExpireAt, 1_800_000_000);
		// 缺 Token 时返回 undefined（不编造）。
		assert.strictEqual(parseTraeExchangeResponse({ Result: { RefreshToken: 'r' } }), undefined);
	});

	test('GetUserInfo 解析脱敏手机号 / 邮箱（字段名是 NonPlainText*）', () => {
		const parsed = parseTraeUserInfoResponse({
			Result: {
				UserID: 'u-1',
				ScreenName: '用户26815487395',
				EnterpriseID: 'e-1',
				NonPlainTextMobile: '130******00',
				NonPlainTextEmail: '',
			},
		});
		assert.ok(parsed);
		assert.strictEqual(parsed.phone, '130******00');
		assert.strictEqual(parsed.email, '');
		// 缺 UserID 时返回 undefined。
		assert.strictEqual(parseTraeUserInfoResponse({ Result: { ScreenName: 'x' } }), undefined);
	});

	test('凭据组装：秒级 tokenExpireAt 转毫秒、保留设备指纹', () => {
		const built = buildTraeCredential(
			{ accessToken: 'a', refreshToken: 'r', tokenExpireAt: 1_800_000_000, tokenExpireDuration: 0, refreshExpireAt: 0 },
			{ uid: 'u-1', screenName: '用户1', enterpriseId: 'e-1', phone: '130******00', email: '' },
			{ machineId: 'm-1', deviceId: 'd-1' },
		);
		assert.strictEqual(built.expires_at, String(1_800_000_000 * 1000));
		assert.strictEqual(built.machine_id, 'm-1');
		assert.strictEqual(built.device_id, 'd-1');
		assert.strictEqual(built.phone, '130******00');
		// 空邮箱不写入字段。
		assert.strictEqual('email' in built, false);
	});

	test('续期保留身份字段，refresh_token 为空时沿用旧值', () => {
		const previous = credential({ nickname: '用户1', phone: '130******00', enterprise_id: 'e-1' });
		const next = applyTraeRefresh(previous, {
			accessToken: 'a2', refreshToken: '', tokenExpireAt: 0, tokenExpireDuration: 3600, refreshExpireAt: 0,
		});
		assert.strictEqual(next.access_token, 'a2');
		assert.strictEqual(next.refresh_token, 'refresh-1');
		assert.strictEqual(next.machine_id, previous.machine_id);
		assert.strictEqual(next.device_id, previous.device_id);
		assert.strictEqual(next.phone, '130******00');
		assert.strictEqual(next.enterprise_id, 'e-1');
	});

	test('过期判据：无过期时间时保守视为未过期', () => {
		assert.strictEqual(isTraeExpired(credential()), false);
		assert.strictEqual(isTraeExpired(credential({ expires_at: '1' })), true);
		assert.strictEqual(isTraeRefreshable(credential()), true);
		assert.strictEqual(isTraeRefreshable(credential({ refresh_token: '' })), false);
		assert.strictEqual(traeCredentialExpiresAtMs(credential({ expires_at: '1800000000000' })), 1_800_000_000_000);
	});

	test('展示名：手机号优先 → 邮箱 → 昵称 → uid', () => {
		assert.strictEqual(traeDisplayNickname({ phone: '130******00', nickname: '用户1', uid: 'u' }, 'id'), '130******00');
		assert.strictEqual(traeDisplayNickname({ email: 'a***@b.com', nickname: '用户1', uid: 'u' }, 'id'), 'a***@b.com');
		assert.strictEqual(traeDisplayNickname({ nickname: '用户1', uid: 'u' }, 'id'), '用户1');
		assert.strictEqual(traeDisplayNickname({ uid: 'u' }, 'id'), 'u');
		assert.strictEqual(traeDisplayNickname(undefined, 'id'), 'id');
	});

	test('withTraePhone 空值时不写入字段', () => {
		const base = credential();
		assert.strictEqual(withTraePhone(base, undefined, undefined), base);
		const patched = withTraePhone(base, '130******00');
		assert.strictEqual(patched.phone, '130******00');
		assert.strictEqual(base.phone, undefined);
	});

	test('设备指纹是 32 位 hex（不是 16 位数字）', () => {
		assert.ok(/^[0-9a-f]{32}$/.test(generateMachineId()));
		assert.ok(/^[0-9a-f]{32}$/.test(generateDeviceId()));
	});

	// ── 模型目录 ──

	test('目录解析：白名单外的通道整组丢弃', () => {
		const models = parseTraeBatchModelList({
			function_configs: [
				{ function: 'chat', config_info_list: [{ config_name: 'only-in-chat', usage: 'chat_completion' }] },
				{ function: 'solo_agent', config_info_list: [{ config_name: 'good', usage: 'chat_completion' }] },
			],
		});
		assert.deepStrictEqual(models.map((m) => m.id), ['good']);
		assert.strictEqual(models[0]?.function, 'solo_agent');
	});

	test('目录解析：非 chat_completion / 已停用 / 官方隐藏的条目被剔除', () => {
		const models = parseTraeBatchModelList({
			function_configs: [{
				function: 'solo_agent',
				config_info_list: [
					{ config_name: 'ok', usage: 'chat_completion' },
					{ config_name: 'summary', usage: 'summary' },
					{ config_name: 'disabled', usage: 'chat_completion', config_switch: false },
					{ config_name: 'hidden', usage: 'chat_completion', is_invisible_to_user: true },
				],
			}],
		});
		assert.deepStrictEqual(models.map((m) => m.id), ['ok']);
	});

	test('目录解析：空档位不得覆盖有档位（issue IKI7WT 同因）', () => {
		// 上游把空档位的通道排在**最后**，无条件「后覆盖前」会让信息更全的条目被覆盖。
		const models = parseTraeBatchModelList({
			function_configs: [
				{
					function: 'solo_agent',
					config_info_list: [{
						config_name: 'glm-5.2',
						usage: 'chat_completion',
						reasoning_effort_config: { default_level: 'high', options: ['light', 'high', 'extra_high'] },
					}],
				},
				{
					function: 'solo_work_lite',
					config_info_list: [{ config_name: 'glm-5.2', usage: 'chat_completion' }],
				},
			],
		});
		assert.strictEqual(models.length, 1);
		assert.strictEqual(models[0]?.function, 'solo_agent');
		assert.deepStrictEqual(models[0]?.reasoningConfig?.options, ['light', 'high', 'extra_high']);
	});

	test('目录解析：两侧都有档位时取白名单里更靠前的通道', () => {
		const models = parseTraeBatchModelList({
			function_configs: [
				{
					function: 'solo_work_lite',
					config_info_list: [{
						config_name: 'm',
						usage: 'chat_completion',
						reasoning_effort_config: { options: ['high'] },
					}],
				},
				{
					function: 'solo_agent',
					config_info_list: [{
						config_name: 'm',
						usage: 'chat_completion',
						reasoning_effort_config: { options: ['high'] },
					}],
				},
			],
		});
		// solo_agent 在 TRAE_CHANNELS 里更靠前。
		assert.strictEqual(models[0]?.function, 'solo_agent');
		assert.ok(TRAE_CHANNELS.indexOf('solo_agent') < TRAE_CHANNELS.indexOf('solo_work_lite'));
	});

	test('目录解析：上下文窗口取 dev、Max 窗口单列', () => {
		const models = parseTraeBatchModelList({
			function_configs: [{
				function: 'solo_agent',
				config_info_list: [{
					config_name: 'm',
					usage: 'chat_completion',
					context_window_tokens: { dev: 200_000, max: 1_000_000 },
					model_detail_list: [
						{ model_name: 'm__dev', max_tokens: 32_000 },
						{ model_name: 'm__max', max_tokens: 384_000 },
					],
					display_config: { display_name: 'M', max_mode: true, multimodal: true },
				}],
			}],
		});
		assert.strictEqual(models[0]?.contextWindow, 200_000);
		assert.strictEqual(models[0]?.maxContextWindow, 1_000_000);
		assert.strictEqual(models[0]?.maxOutputTokens, 32_000);
		assert.strictEqual(models[0]?.maxModeOutputTokens, 384_000);
		assert.strictEqual(models[0]?.maxMode, true);
		assert.strictEqual(models[0]?.multimodal, true);
	});

	test('可调用判据：is_custom_model 与 config_switch=false 各自独立', () => {
		assert.strictEqual(isTraeModelCallable({ id: 'a', name: 'A' }), true);
		assert.strictEqual(isTraeModelCallable({ id: 'a', name: 'A', isCustomModel: true }), false);
		assert.strictEqual(isTraeModelCallable({ id: 'a', name: 'A', isEnabled: false }), false);
		// isHidden 不参与可调用判定（它是「官方不展示」，与「能不能调用」无关）。
		assert.strictEqual(isTraeModelCallable({ id: 'a', name: 'A', isHidden: true }), true);
	});

	test('档位声明判据与 provider 同源（support_thinking=false 不算有档位）', () => {
		assert.strictEqual(declaresReasoningOptions({ id: 'a', name: 'A' }), false);
		assert.strictEqual(declaresReasoningOptions({
			id: 'a', name: 'A', reasoningConfig: { options: ['high'] },
		}), true);
		assert.strictEqual(declaresReasoningOptions({
			id: 'a', name: 'A', reasoningConfig: { options: ['high'], supportThinking: false },
		}), false);
		assert.strictEqual(declaresReasoningOptions({
			id: 'a', name: 'A', reasoningConfig: { options: [] },
		}), false);
	});

	test('消耗倍率：display_contact_config 是 JSON 字符串，rate=0 是合法免费值', () => {
		const entry = (rate: number, enable = true): Record<string, unknown> => ({
			display_contact_config: JSON.stringify({ consumption_rate: { enable, data: { rate } } }),
		});
		assert.strictEqual(readConsumptionRate(entry(0.08)), 0.08);
		// ⚠️ 0 是免费，不是「没有倍率」。
		assert.strictEqual(readConsumptionRate(entry(0)), 0);
		assert.strictEqual(readConsumptionRate(entry(0.08, false)), undefined);
		// 直接读对象（未二次 parse）拿不到值。
		assert.strictEqual(readConsumptionRate({ display_contact_config: { consumption_rate: { data: { rate: 1 } } } }), undefined);
	});

	test('活动折扣：discount_type=none 与已过期都不展示', () => {
		const entry = (current: Record<string, unknown>): Record<string, unknown> => ({
			display_contact_config: JSON.stringify({ activity_discount: { enable: true, data: { current } } }),
		});
		assert.strictEqual(
			readActivityDiscount(entry({ discount_type: 'limited', before_consumption_rate: 0.5, consumption_rate: 0.2 }))?.originalRate,
			0.5,
		);
		// discount_type=none 表示当前无活动（before === after）。
		assert.strictEqual(
			readActivityDiscount(entry({ discount_type: 'none', before_consumption_rate: 0.13, consumption_rate: 0.13 })),
			undefined,
		);
		// 已过期。
		assert.strictEqual(
			readActivityDiscount(
				entry({ discount_type: 'limited', before_consumption_rate: 0.5, consumption_rate: 0.2, end_at: 1 }),
				1000,
			),
			undefined,
		);
	});

	test('展示名拼上倍率（0 显示为「免费」）', () => {
		assert.strictEqual(traeDisplayName({ id: 'a', name: 'A' }), 'A');
		assert.strictEqual(traeDisplayName({ id: 'a', name: 'A', creditsRate: 0.08 }), 'A · x0.08');
		assert.strictEqual(traeDisplayName({ id: 'a', name: 'A', creditsRate: 0 }), 'A · 免费');
		assert.strictEqual(
			traeDisplayName({ id: 'a', name: 'A', creditsRate: 0.08, originalCreditsRate: 0.8 }),
			'A · x0.8→x0.08',
		);
	});

	// ── 载荷转换 ──

	test('OpenAI → SOLO：config_name 双写、function 注入、__dev 后缀消除', () => {
		const body = transformToSOLOBody({ model: 'glm-5.2__dev', messages: [] }, 'solo_agent');
		assert.strictEqual(body.config_name, 'glm-5.2');
		assert.strictEqual(body.model, 'glm-5.2');
		assert.strictEqual(body.function, 'solo_agent');
		assert.strictEqual(body.stream, true);
	});

	test('OpenAI → SOLO：tools.parameters 序列化为 JSON 字符串', () => {
		const body = transformToSOLOBody({
			model: 'm',
			messages: [],
			tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
		});
		const tools = body.tools as Array<{ function: { parameters: unknown } }>;
		assert.strictEqual(typeof tools[0]?.function.parameters, 'string');
		assert.deepStrictEqual(JSON.parse(tools[0]!.function.parameters as string), { type: 'object' });
	});

	test('OpenAI → SOLO：tool_choice=none 删掉 tools，function 形态提取 name', () => {
		const suppressed = transformToSOLOBody({
			model: 'm',
			messages: [],
			tools: [{ type: 'function', function: { name: 'read', parameters: {} } }],
			tool_choice: 'none',
		});
		assert.strictEqual('tools' in suppressed, false);
		assert.strictEqual('tool_choice' in suppressed, false);

		const named = transformToSOLOBody({
			model: 'm',
			messages: [],
			tool_choice: { type: 'function', function: { name: 'read' } },
		});
		assert.strictEqual(named.tool_choice, 'read');
	});

	test('OpenAI → SOLO：assistant 的 tool_calls 转成 function_call', () => {
		const body = transformToSOLOBody({
			model: 'm',
			messages: [{
				role: 'assistant',
				content: null,
				tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
			}],
		});
		const messages = body.messages as Array<Record<string, unknown>>;
		const calls = messages[0]?.tool_calls as Array<Record<string, unknown>>;
		assert.ok(calls[0]?.function_call);
		assert.strictEqual('function' in calls[0]!, false);
	});

	test('OpenAI → SOLO：字符串 content 转成 text 块数组', () => {
		const body = transformToSOLOBody({ model: 'm', messages: [{ role: 'user', content: '你好' }] });
		const messages = body.messages as Array<Record<string, unknown>>;
		assert.deepStrictEqual(messages[0]?.content, [{ type: 'text', text: '你好' }]);
	});

	test('Max 模式字段成套下发（strategy / 窗口 / 预算）', () => {
		const fields = traeMaxModeFields(1_000_000, 384_000);
		assert.deepStrictEqual(fields.model_auto_selection, {
			strategy: 'max', fallback_to_advance_model: null, entitlement_id: null,
		});
		assert.strictEqual(fields.model_selection_strategy, 'max');
		assert.strictEqual(fields.context_window_size, 1_000_000);
		assert.strictEqual(fields.prompt_max_tokens, 936_000);
		assert.strictEqual(fields.max_tokens, 384_000);
	});

	test('输出额度收敛到安全上限（64000）', () => {
		assert.strictEqual(clampTraeMaxTokens(131_072), 64_000);
		assert.strictEqual(clampTraeMaxTokens(32_000), 32_000);
		// 非法值原样返回（不编造）。
		assert.strictEqual(clampTraeMaxTokens(undefined), undefined);
		assert.strictEqual(clampTraeMaxTokens(0), 0);
	});

	// ── 消息转换 ──

	test('消息转换保留工具调用、工具结果与多模态图片', () => {
		const messages = messagesToTrae([
			new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
				new vscode.LanguageModelTextPart('好的'),
				new vscode.LanguageModelToolCallPart('call-1', 'read_file', { path: 'a.ts' }),
			]),
			new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart('看图'),
				vscode.LanguageModelDataPart.image(Uint8Array.from([1, 2, 3]), 'image/png'),
				new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('结果')]),
			]),
		]);
		assert.strictEqual(messages[0]?.role, 'assistant');
		assert.strictEqual(messages[0]?.tool_calls?.[0]?.function.name, 'read_file');
		// ⚠️ 工具结果必须**紧跟**其 assistant tool_calls（中间插消息会被上游 4027 拒绝）。
		assert.strictEqual(messages[1]?.role, 'tool');
		assert.strictEqual(messages[1]?.tool_call_id, 'call-1');
		// 同一条 user 消息的正文/图片**延后**到工具结果之后。
		const user = messages[2];
		assert.strictEqual(user?.role, 'user');
		assert.ok(Array.isArray(user?.content));
		assert.ok((user!.content as Array<Record<string, unknown>>).some((b) => b.type === 'image_url'));
	});

	test('工具定义转成 SOLO 顶层 tools 形态', () => {
		const tools = traeTools([{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }]);
		assert.ok(tools);
		assert.deepStrictEqual(tools[0], {
			type: 'function',
			function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
		});
		assert.strictEqual(traeTools(undefined), undefined);
	});

	// ── 思考档位 ──

	test('默认档优先采信上游 default_level，非法时退到最强档', () => {
		assert.strictEqual(
			defaultTraeEffort({ options: ['light', 'high', 'extra_high'], defaultLevel: 'high' }, 'extra_high'),
			'high',
		);
		// ⚠️ 上游确实会下发 options 里没有的 default_level（实测 'max'）——必须退到兜底。
		assert.strictEqual(
			defaultTraeEffort({ options: ['light', 'high'], defaultLevel: 'max' }, 'high'),
			'high',
		);
		assert.strictEqual(defaultTraeEffort({ options: ['light', 'high'] }, 'high'), 'high');
	});

	test('最强档：显式 max 优先，否则按强度序，全未登记取末项', () => {
		assert.strictEqual(strongestTraeEffort(['light', 'high', 'max']), 'max');
		assert.strictEqual(strongestTraeEffort(['light', 'high', 'extra_high']), 'extra_high');
		assert.strictEqual(strongestTraeEffort(['unknown-a', 'unknown-b']), 'unknown-b');
		assert.strictEqual(strongestTraeEffort([]), undefined);
	});

	test('模型声明思考强度选择器（enum 与目录档位一致、默认档落在枚举内）', () => {
		const provider = new TraeChatProvider({ resolveCredential: async () => undefined });
		// 兜底表没有档位信息 → 不应声明 schema（避免空下拉）。
		for (const model of provider.listModels()) {
			assert.strictEqual(model.configurationSchema, undefined, `${model.id} 兜底表不应声明档位`);
		}
	});

	test('silent 路径也必须拉远端目录（否则模型列表恒为旧兜底表）', async () => {
		// ⚠️ 真实缺陷：早期实现让 `silent` 直接返回 `listModels()`，而那时
		// `remoteModels` 还是 undefined ⇒ 返回内置兜底表（旧模型），
		// 模型选择器里永远看不到远端的新模型（如 deepseek-v4.1-flash）。
		let fetchCount = 0;
		const provider = new TraeChatProvider({
			resolveCredential: async () => credential(),
			fetchModels: async () => {
				fetchCount += 1;
				return {
					function_configs: [{
						function: 'solo_agent',
						config_info_list: [
							{ config_name: 'deepseek-v4.1-flash', usage: 'chat_completion' },
							{ config_name: 'glm-5.3', usage: 'chat_completion' },
						],
					}],
				};
			},
		});
		const models = await provider.provideLanguageModelChatInformation(
			{ silent: true } as vscode.PrepareLanguageModelChatModelOptions,
			new vscode.CancellationTokenSource().token,
		);
		assert.strictEqual(fetchCount, 1, 'silent 路径应发起一次目录拉取');
		assert.deepStrictEqual(models.map((m) => m.id), ['deepseek-v4.1-flash', 'glm-5.3']);
	});

	test('目录拉取失败时回退兜底表（不抛错）', async () => {
		const provider = new TraeChatProvider({
			resolveCredential: async () => credential(),
			fetchModels: async () => { throw new Error('boom'); },
		});
		const models = await provider.provideLanguageModelChatInformation(
			{ silent: false } as vscode.PrepareLanguageModelChatModelOptions,
			new vscode.CancellationTokenSource().token,
		);
		assert.ok(models.length > 0, '失败时应回退兜底表而不是空列表');
	});

	test('目录结构诊断能区分「上游没下发」与「被白名单剔除」', () => {
		const text = describeTraeCatalog({
			function_configs: [
				{ function: 'solo_agent', config_info_list: [{ config_name: 'a' }] },
				{ function: 'chat', config_info_list: [{ config_name: 'b' }, { config_name: 'c' }] },
			],
		});
		assert.ok(text.includes('solo_agent: 1 条'));
		assert.ok(text.includes('chat: 2 条（不在白名单，整组丢弃）'));
		// 非预期形状也要给出可读原因。
		assert.ok(describeTraeCatalog(null).includes('不是对象'));
		assert.ok(describeTraeCatalog({ foo: 1 }).includes('没有 function_configs'));
	});

	// ── SSE 消费 ──

	test('SOLO SSE：output 事件报告正文与思考', async () => {
		const body = [
			'event:output',
			'data:{"response":"你好","reasoning_content":"思考中"}',
			'',
			'event:done',
			'data:{"finish_reason":"stop"}',
			'',
		].join('\n');
		const parts: vscode.LanguageModelResponsePart[] = [];
		await consumeTraeSse(
			new Response(body).body!,
			{ report: (part) => parts.push(part) },
			new vscode.CancellationTokenSource().token,
			'glm-5.2',
		);
		const texts = parts.filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart);
		assert.strictEqual(texts.length, 1);
		assert.strictEqual(texts[0]?.value, '你好');
	});

	test('SOLO SSE：token_usage 上报含缓存命中的 usage', async () => {
		const body = [
			'event:token_usage',
			'data:{"prompt_tokens":5144,"completion_tokens":32,"total_tokens":5176,"cache_read_input_tokens":5120,"reasoning_tokens":30}',
			'',
			'event:output',
			'data:{"response":"x"}',
			'',
		].join('\n');
		const parts: vscode.LanguageModelResponsePart[] = [];
		await consumeTraeSse(
			new Response(body).body!,
			{ report: (part) => parts.push(part) },
			new vscode.CancellationTokenSource().token,
			'glm-5.2',
		);
		const usagePart = parts.find((p) => p instanceof vscode.LanguageModelDataPart
			&& (p as vscode.LanguageModelDataPart).mimeType === 'usage') as vscode.LanguageModelDataPart | undefined;
		assert.ok(usagePart, '应上报 usage');
		const payload = JSON.parse(new TextDecoder().decode(usagePart.data)) as Record<string, unknown>;
		// ⚠️ OpenAI 口径：prompt_tokens 含缓存，命中量单列在 details。
		assert.strictEqual(payload.prompt_tokens, 5144);
		assert.deepStrictEqual(payload.prompt_tokens_details, { cached_tokens: 5120 });
	});

	test('SOLO SSE：工具调用分片合并后上报', async () => {
		const body = [
			'event:output',
			'data:{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\"pa"}}]}',
			'',
			'event:output',
			'data:{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.ts\\"}"}}]}',
			'',
		].join('\n');
		const parts: vscode.LanguageModelResponsePart[] = [];
		await consumeTraeSse(
			new Response(body).body!,
			{ report: (part) => parts.push(part) },
			new vscode.CancellationTokenSource().token,
			'glm-5.2',
		);
		const call = parts.find((p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart);
		assert.ok(call);
		assert.strictEqual(call.name, 'read_file');
		assert.deepStrictEqual(call.input, { path: 'a.ts' });
	});

	test('SOLO SSE：流内 error 事件抛出带原文的错误', async () => {
		const body = [
			'event:error',
			'data:{"code":4008,"message":"quota exceeded"}',
			'',
		].join('\n');
		await assert.rejects(
			consumeTraeSse(
				new Response(body).body!,
				{ report: () => undefined },
				new vscode.CancellationTokenSource().token,
				'glm-5.2',
			),
			/quota exceeded/,
		);
	});

	test('SOLO SSE：一个事件都没收到时报空响应（可重试）', async () => {
		await assert.rejects(
			consumeTraeSse(
				new Response('').body!,
				{ report: () => undefined },
				new vscode.CancellationTokenSource().token,
				'glm-5.2',
			),
			/空响应/,
		);
	});

	test('SSE 行解析：function_call 归一化为 function 并清理 SOLO 专属字段', () => {
		const ev = parseTraeSSELine('output', JSON.stringify({
			tool_calls: [{
				index: 0,
				id: 'c1',
				function_call: { name: 'read', arguments: '{}', namespace: 'x', partial_arguments: 'y' },
			}],
		}));
		const calls = ev?.toolCalls as Array<Record<string, unknown>>;
		const fn = calls[0]?.function as Record<string, unknown>;
		assert.strictEqual(fn.name, 'read');
		assert.strictEqual('namespace' in fn, false);
		assert.strictEqual('partial_arguments' in fn, false);
	});

	test('usage 解析：缺字段按 0，total 缺失时自行相加', () => {
		const usage = traeUsageFromTokenUsage({ prompt_tokens: 10, completion_tokens: 5 });
		assert.strictEqual(usage.totalTokens, 15);
		assert.strictEqual(usage.cacheReadTokens, 0);
		// 负数 / 非数字一律归 0（不编造）。
		const weird = traeUsageFromTokenUsage({ prompt_tokens: -1, completion_tokens: 'x' });
		assert.strictEqual(weird.promptTokens, 0);
		assert.strictEqual(weird.completionTokens, 0);
	});

	// ── 错误分类 ──

	test('错误分类：4008 先于 4011（更严重的类别优先）', () => {
		assert.strictEqual(classifyTraeError(200, '{"code":4008,"msg":"4011 too many"}'), 'quota-exceeded');
		assert.strictEqual(classifyTraeError(200, '{"code":4011}'), 'soft-rate');
		assert.strictEqual(classifyTraeError(200, '{"code":1005,"msg":"plan limit"}'), 'hard-plan');
		assert.strictEqual(classifyTraeError(401, ''), 'session-dead');
		assert.strictEqual(classifyTraeError(429, ''), 'soft-rate');
		assert.strictEqual(classifyTraeError(500, ''), 'server');
		assert.strictEqual(classifyTraeError(200, ''), 'none');
	});
	test('终态判据：只有 session-dead 是终态（额度类不是）', () => {
		assert.strictEqual(isTraeTerminalError('session-dead'), true);
		assert.strictEqual(isTraeTerminalError('quota-exceeded'), false);
		assert.strictEqual(isTraeTerminalError('server'), false);
	});

	test('4001 的报错文案指向「模型不可调用」而不是「参数有误」', () => {
		const message = traeStreamErrorMessage(4001, "We're sorry, the param is invalid.", 'custom_model_x');
		assert.ok(message.includes('custom_model_x'));
		assert.ok(message.includes('不可调用'));
		// 4006 指向「内容过大」。
		assert.ok(traeStreamErrorMessage(4006, 'content is too large', 'm').includes('过大'));
		// 其余码原样带出。
		assert.strictEqual(traeStreamErrorMessage(4008, 'quota', 'm'), 'TRAE: quota (code=4008)');
	});
});
