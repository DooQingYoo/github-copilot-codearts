import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	applyQoderRefresh,
	buildQoderAuthUrl,
	buildQoderCredential,
	buildQoderPollUrl,
	createQoderDeviceSession,
	isQoderExpired,
	isQoderRefreshable,
	parseQoderTokenPayload,
	qoderBearerToken,
	qoderCredentialExpiresAtMs,
	qoderRefreshBody,
	QODER_CN,
	type QoderCredential,
} from '../qoder-cn';
import {
	QODER_CN_FALLBACK_MODELS,
	qoderCnDisplayName,
	qoderCnEffortsFor,
	promotionActiveNow,
} from '../qoder-cn-models';
import { consumeQoderSse, messagesToQoder, qoderTools, QoderCnChatProvider } from '../qoder-cn-provider';
import { buildQoderInferPayload } from '../qoder-cn-wasm';

suite('Qoder (中国版) 测试', () => {
	test('设备码会话生成 PKCE 与稳定 machine_id', () => {
		const session = createQoderDeviceSession('machine-1');
		assert.strictEqual(session.machineId, 'machine-1');
		assert.ok(session.pkce.verifier.length >= 43 && session.pkce.verifier.length <= 128);
		// challenge 是 base64url 且去掉了 padding
		assert.ok(/^[A-Za-z0-9_-]+$/.test(session.pkce.challenge));
	});

	test('授权 URL 与轮询 URL 指向正确的 host', () => {
		const session = createQoderDeviceSession('machine-1');
		const authUrl = buildQoderAuthUrl(session);
		assert.ok(authUrl.startsWith('https://qoder.cn/device/selectAccounts?'));
		assert.ok(authUrl.includes('challenge_method=S256'));
		assert.ok(authUrl.includes(`client_id=${QODER_CN.clientId}`));

		const pollUrl = buildQoderPollUrl(session);
		assert.ok(pollUrl.startsWith('https://openapi.qoder.com.cn/api/v1/deviceToken/poll?'));
	});

	test('解析令牌载荷（token / device_token / 秒与毫秒时间戳）', () => {
		const login = parseQoderTokenPayload({
			token: 'tok-1',
			refresh_token: 'refresh-1',
			expires_at: 1_700_000_000,
			user_id: 'u-1',
			user_name: 'Alice',
		});
		assert.strictEqual(login.accessToken, 'tok-1');
		assert.strictEqual(login.refreshToken, 'refresh-1');
		assert.strictEqual(login.expiresAt, 1_700_000_000_000);
		assert.strictEqual(login.uid, 'u-1');
		assert.strictEqual(login.userName, 'Alice');

		const refresh = parseQoderTokenPayload({ device_token: 'tok-2' });
		assert.strictEqual(refresh.accessToken, 'tok-2');

		// 垃圾输入返回空 accessToken，不抛错
		assert.strictEqual(parseQoderTokenPayload(null).accessToken, '');
	});

	test('构造凭据：双写令牌、持久化 machine_id、保留 uid', () => {
		const credential = buildQoderCredential(
			{ accessToken: 'tok', refreshToken: 'rt', expiresAt: 1234, uid: 'u-9' },
			{ machineId: 'm-1' },
		);
		assert.strictEqual(credential.access_token, 'tok');
		assert.strictEqual(credential.security_oauth_token, 'tok');
		assert.strictEqual(credential.machine_id, 'm-1');
		assert.strictEqual(credential.uid, 'u-9');
		assert.strictEqual(qoderBearerToken(credential), 'tok');
		assert.ok(isQoderRefreshable(credential));
		assert.strictEqual(qoderCredentialExpiresAtMs(credential), 1234);
	});

	test('续期请求体只发 refresh_token 与 machine_id', () => {
		const credential: QoderCredential = {
			access_token: 'a',
			security_oauth_token: 'a',
			refresh_token: 'r',
			machine_id: 'm-2',
			uid: 'u',
		};
		assert.deepStrictEqual(qoderRefreshBody(credential), { refresh_token: 'r', machine_id: 'm-2' });
	});

	test('续期结果保留 machine_id / uid（响应里不带它们）', () => {
		const old: QoderCredential = {
			access_token: 'a',
			security_oauth_token: 'a',
			refresh_token: 'r',
			machine_id: 'm-3',
			uid: 'u-3',
			nickname: 'Bob',
		};
		const next = applyQoderRefresh(old, { accessToken: 'a2', expiresAt: 9999 });
		assert.strictEqual(next.machine_id, 'm-3');
		assert.strictEqual(next.uid, 'u-3');
		assert.strictEqual(next.nickname, 'Bob');
		// 续期响应未带新 refresh_token 时沿用旧的
		assert.strictEqual(next.refresh_token, 'r');
	});

	test('过期判据：无过期时间时保守视为未过期', () => {
		assert.strictEqual(isQoderExpired({ access_token: 'a', security_oauth_token: 'a', machine_id: 'm' }), false);
		assert.strictEqual(isQoderExpired({ access_token: 'a', security_oauth_token: 'a', machine_id: 'm', expire_time: 1 }, 1000), true);
	});

	test('模型目录含 CN 独有模型、不含国际版独有模型，且 qfmodel 免费', () => {
		const ids = QODER_CN_FALLBACK_MODELS.map((m) => m.id);
		assert.ok(ids.includes('q37fmodel'));
		assert.ok(ids.includes('gm51model'));
		assert.ok(!ids.includes('ultimate'));
		const qfmodel = QODER_CN_FALLBACK_MODELS.find((m) => m.id === 'qfmodel');
		assert.ok(qfmodel);
		assert.strictEqual(qfmodel.priceFactor, 0);
		assert.ok(qoderCnDisplayName(qfmodel).includes('免费'));
		assert.strictEqual(qoderCnEffortsFor(qfmodel).includes('none'), true);
	});

	test('模型声明思考强度选择器（enum 与目录档位一致、默认档落在枚举内）', () => {
		const provider = new QoderCnChatProvider({ resolveCredential: async () => undefined });
		const models = provider.listModels();
		assert.ok(models.length > 0);
		// ⚠️ 逐模型核对：**每个**有档位的模型都要声明 schema，且默认档必须落在枚举内
		// （否则 UI 里的默认选中项是个不存在的值，用户不选就会发出非法档位）。
		let declared = 0;
		for (const model of models) {
			const fallback = QODER_CN_FALLBACK_MODELS.find((m) => m.id === model.id);
			assert.ok(fallback);
			const efforts = qoderCnEffortsFor(fallback);
			const schema = model.configurationSchema;
			if (efforts.length === 0) {
				assert.strictEqual(schema, undefined, `${model.id} 无档位时不应声明 schema`);
				continue;
			}
			declared += 1;
			assert.ok(schema, `${model.id} 应声明 configurationSchema`);
			const prop = schema.properties?.reasoningEffort;
			assert.ok(prop, `${model.id} 应声明 reasoningEffort`);
			assert.deepStrictEqual([...(prop.enum ?? [])], [...efforts]);
			assert.ok(prop.enum?.includes(prop.default as string), `${model.id} 默认档须在枚举内`);
			assert.strictEqual((prop.enumItemLabels ?? []).length, efforts.length);
		}
		assert.ok(declared > 0, '至少应有一个模型暴露思考档位');
	});

	test('错峰折扣按 UTC+8 本地推算', () => {
		// 22:00–08:00 窗口：UTC+8 的 23:00 命中、12:00 不命中
		const promo = { active: false, discountFactor: 0.4, beforePromotionPriceFactor: 0.5, windowStart: '22:00', windowEnd: '08:00' };
		const at23 = new Date(Date.UTC(2026, 0, 1, 15, 0)); // UTC 15:00 = UTC+8 23:00
		const at12 = new Date(Date.UTC(2026, 0, 1, 4, 0)); // UTC 4:00 = UTC+8 12:00
		assert.strictEqual(promotionActiveNow(promo, at23), true);
		assert.strictEqual(promotionActiveNow(promo, at12), false);
	});

	test('消息转换保留工具调用、工具结果与多模态图片', () => {
		const messages = messagesToQoder([
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
		// 带图消息的 content 必须是数组且含 image_url
		const user = messages[1];
		assert.ok(Array.isArray(user?.content));
		assert.ok((user!.content as Array<Record<string, unknown>>).some((b) => b.type === 'image_url'));
		// 工具结果作为独立 tool 消息且带 tool_call_id
		assert.strictEqual(messages[2]?.role, 'tool');
		assert.strictEqual(messages[2]?.tool_call_id, 'call-1');
	});

	test('工具定义转成加密端点顶层 tools 形态', () => {
		const tools = qoderTools([
			{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
		]);
		assert.strictEqual(tools[0]?.type, 'function');
		assert.strictEqual(tools[0]?.function.name, 'read_file');
		assert.strictEqual(tools[0]?.function.parameters?.type, 'object');
	});

	test('加密请求体带上 business、tools 与 session_type', () => {
		const payload = buildQoderInferPayload(
			{
				modelKey: 'qfmodel',
				userText: '你好',
				tools: [{ type: 'function', function: { name: 't' } }],
				sessionType: 'qoder_work',
				business: { type: 'agent' },
			},
			'fixed-id',
		);
		assert.strictEqual(payload.request_id, 'fixed-id');
		assert.strictEqual(payload.session_type, 'qoder_work');
		assert.deepStrictEqual(payload.business, { type: 'agent' });
		assert.strictEqual((payload.model_config as Record<string, unknown>).key, 'qfmodel');
		assert.strictEqual((payload.tools as unknown[]).length, 1);
		// chat_context 不能是空对象
		assert.strictEqual((payload.chat_context as Record<string, unknown>).text, '你好');
	});

	test('思考档位透传为 reasoning_effort，并据「关闭」推出 enable_thinking=false', () => {
		// 选中档位：应与 enable_thinking=true 一起下发
		const on = buildQoderInferPayload(
			{ modelKey: 'dmodel', userText: 'hi', isReasoning: true, reasoningEffort: 'high' },
			'id-on',
		);
		const onParams = on.parameters as Record<string, unknown>;
		assert.strictEqual(onParams.reasoning_effort, 'high');
		assert.strictEqual(onParams.enable_thinking, true);

		// 关闭思考：`none` 必须把 enable_thinking 翻成 false，而不是照发 `none`
		const off = buildQoderInferPayload(
			{ modelKey: 'dmodel', userText: 'hi', isReasoning: true, reasoningEffort: 'none' },
			'id-off',
		);
		const offParams = off.parameters as Record<string, unknown>;
		assert.strictEqual(offParams.reasoning_effort, 'none');
		assert.strictEqual(offParams.enable_thinking, false);

		// 未选档位：不得凭空补字段（保持网关默认）
		const bare = buildQoderInferPayload({ modelKey: 'dmodel', userText: 'hi' }, 'id-bare');
		const bareParams = bare.parameters as Record<string, unknown>;
		assert.strictEqual('reasoning_effort' in bareParams, false);
	});

	test('信封里包着 [DONE] 的结束帧被静默跳过（不报无法解析）', async () => {
		// 真实报文：`body` 是字符串 `"[DONE]"`（Qoder 的结束帧形态）
		const body = 'data: {"headers":{"Content-Type":["application/json"]},"body":"[DONE]","statusCodeValue":200,"statusCode":"OK"}\n\n';
		const parts: vscode.LanguageModelResponsePart[] = [];
		await consumeQoderSse(
			new Response(body).body!,
			{ report: (part) => parts.push(part) },
			new vscode.CancellationTokenSource().token,
		);
		assert.strictEqual(parts.length, 0);
	});

	test('信封里的正常 chunk 被剥出并报告文本', async () => {
		const chunk = JSON.stringify({ choices: [{ delta: { content: '你好' } }] });
		const body = `data: ${JSON.stringify({ headers: {}, body: chunk, statusCodeValue: 200, statusCode: 'OK' })}\n\n`;
		const parts: vscode.LanguageModelResponsePart[] = [];
		await consumeQoderSse(
			new Response(body).body!,
			{ report: (part) => parts.push(part) },
			new vscode.CancellationTokenSource().token,
		);
		assert.strictEqual(parts.length, 1);
		assert.ok(parts[0] instanceof vscode.LanguageModelTextPart);
		assert.strictEqual((parts[0] as vscode.LanguageModelTextPart).value, '你好');
	});

	test('信封里内层 body 为 null 的心跳帧被静默跳过', async () => {
		const body = 'data: {"headers":{},"body":null,"statusCodeValue":200,"statusCode":"OK"}\n\n';
		const parts: vscode.LanguageModelResponsePart[] = [];
		await consumeQoderSse(
			new Response(body).body!,
			{ report: (part) => parts.push(part) },
			new vscode.CancellationTokenSource().token,
		);
		assert.strictEqual(parts.length, 0);
	});

	test('无法解析的纯文本帧报错时带出原文（便于定位）', async () => {
		const body = 'data: [FAIL]node:oa_qwen-plus-2025-04-28 msg:Execution failed\n\n';
		await assert.rejects(
			consumeQoderSse(
				new Response(body).body!,
				{ report: () => undefined },
				new vscode.CancellationTokenSource().token,
			),
			/Execution failed/,
		);
	});
});
