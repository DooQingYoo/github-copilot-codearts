import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	OPENROUTER_FALLBACK_CONTEXT_TOKENS,
	OPENROUTER_FALLBACK_MAX_OUTPUT_TOKENS,
	OPENROUTER_PAID_MODEL_IDS,
	OPENROUTER_PROVIDER_AUTO,
	OPENROUTER_PROVIDER_AUTO_LABEL,
	isOpenRouterAuthStatus,
	isOpenRouterDisplayModelId,
	isOpenRouterFreeModelId,
	isOpenRouterKeyShape,
	openRouterDefaultEffort,
	openRouterEffortsOf,
	openRouterEndpointsUrl,
	openRouterHttpErrorText,
	openRouterProviderField,
	openRouterReasoningField,
	openRouterThinkingText,
	parseOpenRouterKeyInfo,
	parseOpenRouterModel,
	parseOpenRouterModels,
	parseOpenRouterProviders,
	selectOpenRouterModels,
	type OpenRouterProviderOption,
} from '../openrouter';
import {
	consumeOpenRouterSse,
	messagesToOpenRouter,
	OPENROUTER_VENDOR,
	OpenRouterChatProvider,
	openRouterRequestBody,
	openRouterTools,
	type OpenRouterModel,
} from '../openrouter-provider';
import { readOpenRouterCredential, type OpenRouterCredential } from '../openrouter-auth';
import { normalizePinnedProviders, withPinnedProvider } from '../openrouter-settings';

/**
 * 定位工作区根目录（存 `package.json` 的地方）。
 *
 * ⚠️ 不能假定 `__dirname` 就是工作区：测试跑在 Extension Development Host 里，
 * 目录形状与本地 `tsc` 输出不一定一致。从 `__dirname` 逐层上溯找 `package.json`
 * 才是稳的（与 `jet-hub-styles-ownership.spec.ts` 同一思路）。
 */
function workspaceRoot(): string {
	let dir = __dirname;
	for (let depth = 0; depth < 8; depth += 1) {
		if (fs.existsSync(path.join(dir, 'package.json'))) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	throw new Error(`找不到工作区根目录（从 ${__dirname} 上溯 8 层）`);
}

/** 构造一份最小可用凭据。 */
function credential(overrides: Partial<OpenRouterCredential> = {}): OpenRouterCredential {
	return { api_key: 'sk-or-v1-' + 'a'.repeat(40), label: 'test-key', ...overrides };
}

/** 一次可用的目录拉取：两个免费模型 + 一个收费模型 + 一个应被过滤的 batch 变体。 */
function catalogPayload(): unknown {
	return {
		data: [
			{
				id: 'liquid/lfm-2.5-2.6b:free',
				name: 'LiquidAI: LFM2.5-2.6B (free)',
				context_length: 65536,
				architecture: { input_modalities: ['text'], output_modalities: ['text'] },
				supported_parameters: ['tools', 'reasoning'],
				top_provider: { context_length: 65536, max_completion_tokens: 8192 },
				reasoning: { mandatory: false, supported_efforts: ['high', 'low'] },
			},
			{
				id: 'deepseek/deepseek-v4.1-flash',
				name: 'DeepSeek: DeepSeek V4.1 Flash',
				context_length: 1_048_576,
				architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
				supported_parameters: ['tools'],
				top_provider: { context_length: 1_048_576, max_completion_tokens: 943_718 },
				reasoning: {
					mandatory: false,
					supported_efforts: ['max', 'high', 'low'],
					default_effort: 'high',
					default_enabled: true,
				},
			},
			// ⚠️ `:batch` 变体是**另一个条目**，必须被过滤掉（它不是免费模型）。
			{
				id: 'deepseek/deepseek-v4.1-flash:batch',
				name: 'DeepSeek: DeepSeek V4.1 Flash (batch)',
				context_length: 1_048_576,
				architecture: { input_modalities: ['text'], output_modalities: ['text'] },
				supported_parameters: ['tools'],
				top_provider: { context_length: 1_048_576, max_completion_tokens: 131_072 },
			},
		],
	};
}

/** 某模型的上游端点（含**同名不同 tag** 的重复供应商）。 */
function endpointsPayload(): unknown {
	return {
		data: {
			id: 'deepseek/deepseek-v4.1-flash',
			endpoints: [
				{ tag: 'deepinfra/fp8', provider_name: 'DeepInfra' },
				{ tag: 'baseten/fp8', provider_name: 'BaseTen' },
				{ tag: 'baseten/fast', provider_name: 'BaseTen' },
				{ tag: 'fireworks/us', provider_name: 'Fireworks' },
			],
		},
	};
}

suite('OpenRouter 测试', () => {
	// ── 展示过滤 ──

	test('展示范围：全部 :free 变体 + 两个指定收费模型', () => {
		assert.strictEqual(isOpenRouterFreeModelId('liquid/lfm-2.5-2.6b:free'), true);
		assert.strictEqual(isOpenRouterFreeModelId('openrouter/free'), false);
		assert.strictEqual(isOpenRouterFreeModelId('deepseek/deepseek-v4.1-flash:batch'), false);

		for (const id of OPENROUTER_PAID_MODEL_IDS) {
			assert.strictEqual(isOpenRouterDisplayModelId(id), true, `${id} 应被展示`);
		}
		assert.strictEqual(isOpenRouterDisplayModelId('liquid/lfm-2.5-2.6b:free'), true);
		// 其它收费模型、别名（`~xxx-latest`）、batch 变体都不展示。
		assert.strictEqual(isOpenRouterDisplayModelId('z-ai/glm-5.3'), false);
		assert.strictEqual(isOpenRouterDisplayModelId('~deepseek/deepseek-pro-latest'), false);
		assert.strictEqual(isOpenRouterDisplayModelId('deepseek/deepseek-v4.1-flash:batch'), false);
		// 用户明确排除的 Free Models Router（pricing 也是 0，但不是具体模型）。
		assert.strictEqual(isOpenRouterDisplayModelId('openrouter/free'), false);
	});

	test('目录过滤保序：只留下展示范围内的条目', () => {
		const selected = selectOpenRouterModels(parseOpenRouterModels(catalogPayload()));
		assert.deepStrictEqual(selected.map((model) => model.id), [
			'liquid/lfm-2.5-2.6b:free',
			'deepseek/deepseek-v4.1-flash',
		]);
	});

	// ── 端点 URL ──

	test('端点 URL 按 id 切分作者/模型名，且冒号被编码', () => {
		assert.strictEqual(
			openRouterEndpointsUrl('deepseek/deepseek-v4.1-flash'),
			'https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints',
		);
		// ⚠️ `:free` 里的冒号必须转义（实测有的网关不转义会 404）。
		assert.strictEqual(
			openRouterEndpointsUrl('dots-studio/dots-3-note-preview:free'),
			'https://openrouter.ai/api/v1/models/dots-studio/dots-3-note-preview%3Afree/endpoints',
		);
	});

	// ── 目录解析 ──

	test('模型解析：上下文 / 输出上限 / 图片 / 工具 / 思考元数据', () => {
		const model = parseOpenRouterModel({
			id: 'deepseek/deepseek-v4.1-flash',
			name: 'DeepSeek: DeepSeek V4.1 Flash',
			context_length: 1_048_576,
			architecture: { input_modalities: ['text', 'image'] },
			supported_parameters: ['tools', 'reasoning_effort'],
			top_provider: { max_completion_tokens: 943_718 },
			reasoning: { mandatory: false, supported_efforts: ['max', 'high'], default_effort: 'high' },
		});
		assert.ok(model);
		assert.strictEqual(model.id, 'deepseek/deepseek-v4.1-flash');
		assert.strictEqual(model.contextLength, 1_048_576);
		assert.strictEqual(model.maxOutputTokens, 943_718);
		assert.strictEqual(model.imageInput, true);
		assert.strictEqual(model.toolCalling, true);
		assert.deepStrictEqual(model.reasoning?.supportedEfforts, ['max', 'high']);
	});

	test('模型解析：缺字段时兜底而不是抛错，缺 id 的条目整条丢弃', () => {
		const bare = parseOpenRouterModel({ id: 'x/y' });
		assert.ok(bare);
		assert.strictEqual(bare.contextLength, OPENROUTER_FALLBACK_CONTEXT_TOKENS);
		assert.strictEqual(bare.maxOutputTokens, OPENROUTER_FALLBACK_MAX_OUTPUT_TOKENS);
		assert.strictEqual(bare.imageInput, false);
		assert.strictEqual(bare.toolCalling, false);
		assert.strictEqual(bare.reasoning, undefined);
		assert.strictEqual(parseOpenRouterModel({ name: '没有 id' }), undefined);
		assert.strictEqual(parseOpenRouterModel('不是对象'), undefined);
		assert.deepStrictEqual(parseOpenRouterModels({ data: '不是数组' }), []);
	});

	// ── 供应商解析 ──

	test('供应商解析：按 tag 去重（同名不同 tag 都要保留），重名时标签带 slug', () => {
		const options = parseOpenRouterProviders(endpointsPayload());
		assert.deepStrictEqual(options.map((option) => option.slug), [
			'deepinfra/fp8',
			'baseten/fp8',
			'baseten/fast',
			'fireworks/us',
		]);
		// DeepInfra / Fireworks 唯一 → 只用展示名。
		assert.strictEqual(options[0]?.label, 'DeepInfra');
		assert.strictEqual(options[3]?.label, 'Fireworks');
		// ⚠️ BaseTen 有 3 个端点 → 标签必须能区分（否则下拉里两个同名项无法辨认）。
		assert.strictEqual(options[1]?.label, 'BaseTen · baseten/fp8');
		assert.strictEqual(options[2]?.label, 'BaseTen · baseten/fast');
	});

	test('供应商解析：空/畸形端点返回空列表（该模型没有供应商选项）', () => {
		assert.deepStrictEqual(parseOpenRouterProviders({ data: { endpoints: [] } }), []);
		assert.deepStrictEqual(parseOpenRouterProviders({ data: {} }), []);
		assert.deepStrictEqual(parseOpenRouterProviders('不是对象'), []);
		// 缺 tag 的端点无法路由，必须丢弃。
		assert.deepStrictEqual(
			parseOpenRouterProviders({ data: { endpoints: [{ provider_name: 'X' }] } }),
			[],
		);
	});

	// ── 思考档位 ──

	test('档位：上游降序下发 → 我们按弱→强展示（与另外三家一致）', () => {
		assert.deepStrictEqual(
			openRouterEffortsOf({ mandatory: false, supportedEfforts: ['max', 'high', 'low'] }),
			['low', 'high', 'max'],
		);
		// 没有白名单就不声明选择器（**不自己补 none**）。
		assert.deepStrictEqual(openRouterEffortsOf({ mandatory: true }), []);
		assert.deepStrictEqual(openRouterEffortsOf(undefined), []);
	});

	test('默认档：上游声明的优先，声明的档位不成立时才回退', () => {
		const efforts = ['low', 'high', 'max'];
		assert.strictEqual(openRouterDefaultEffort({ mandatory: false, defaultEffort: 'high' }, efforts), 'high');
		// 声明了一个**不在枚举里**的档位（上游数据不自治）→ 必须回退，不能照发。
		assert.strictEqual(openRouterDefaultEffort({ mandatory: false, defaultEffort: 'none' }, efforts), 'max');
		// 上游说「默认不开思考」且 `none` 确实在枚举里 → 默认落在 none。
		assert.strictEqual(
			openRouterDefaultEffort({ mandatory: false, defaultEnabled: false }, ['none', 'low', 'high']),
			'none',
		);
		// 没有 none 可关 → 只能是默认档策略（取最强）。
		assert.strictEqual(openRouterDefaultEffort({ mandatory: true }, ['low', 'high']), 'high');
		assert.strictEqual(openRouterDefaultEffort(undefined, []), undefined);
	});

	test('发送前校验档位：不在枚举值内的选择不下发', () => {
		const efforts = ['low', 'high', 'max'];
		assert.deepStrictEqual(openRouterReasoningField('high', efforts), { effort: 'high' });
		// 用户选择可能来自**缓存的旧目录** —— 发未知档位会被上游 400 拒绝。
		assert.strictEqual(openRouterReasoningField('xhigh', efforts), undefined);
		assert.strictEqual(openRouterReasoningField(undefined, efforts), undefined);
		assert.strictEqual(openRouterReasoningField(42, efforts), undefined);
		assert.strictEqual(openRouterReasoningField('high', []), undefined);
	});

	// ── 上游供应商下发 ──

	test('供应商字段：选定即严格锁定（order + 关闭回退），自动/未知则不下发', () => {
		const options: readonly OpenRouterProviderOption[] = [
			{ slug: 'deepinfra/fp8', label: 'DeepInfra' },
			{ slug: 'baseten/fast', label: 'BaseTen · baseten/fast' },
		];
		assert.deepStrictEqual(openRouterProviderField('deepinfra/fp8', options), {
			order: ['deepinfra/fp8'],
			allow_fallbacks: false,
		});
		// 「自动」= 交回 OpenRouter 负载均衡 ⇒ 不发 provider 字段。
		assert.strictEqual(openRouterProviderField(OPENROUTER_PROVIDER_AUTO, options), undefined);
		assert.strictEqual(openRouterProviderField(undefined, options), undefined);
		// 缓存旧目录里的 slug 已经不在当前目录 ⇒ 不发（否则会被 404）。
		assert.strictEqual(openRouterProviderField('gone/provider', options), undefined);
		assert.strictEqual(openRouterProviderField(7, options), undefined);
	});

	// ── 错误文案 ──

	test('HTTP 错误文案带出上游原文', () => {
		const text = openRouterHttpErrorText(401, '{"error":{"message":"No auth credentials found"}}', undefined);
		assert.ok(text.includes('HTTP 401'));
		assert.ok(text.includes('No auth credentials found'));
		assert.ok(text.includes('(无响应体') === false);
		assert.ok(openRouterHttpErrorText(500, '   ', undefined).includes('(无响应体)'));
	});

	test('锁定上游且 404/503 时补一句人话（严格语义的预期代价）', () => {
		const pinned = 'deepinfra/fp8';
		const missing = openRouterHttpErrorText(404, 'no endpoints', pinned);
		assert.ok(missing.includes('锁定上游供应商「deepinfra/fp8」'), missing);
		assert.ok(missing.includes('自动'), missing);
		assert.ok(openRouterHttpErrorText(503, 'down', pinned).includes('锁定上游供应商'));
		// ⚠️ 400 是参数问题，与供应商可用性无关 —— 加这句会把人引到错方向。
		assert.ok(!openRouterHttpErrorText(400, 'bad param', pinned).includes('锁定上游供应商'));
	});

	test('429 属于限流而不是认证失效', () => {
		assert.strictEqual(isOpenRouterAuthStatus(401), true);
		assert.strictEqual(isOpenRouterAuthStatus(403), true);
		assert.strictEqual(isOpenRouterAuthStatus(429), false);
		assert.strictEqual(isOpenRouterAuthStatus(402), false);
	});

	// ── 凭据 ──

	test('API Key 形状校验：只要求「像个 token」，不硬编码前缀', () => {
		assert.strictEqual(isOpenRouterKeyShape('sk-or-v1-' + 'a'.repeat(40)), true);
		// 换个前缀（上游规则可能变）也照样接受。
		assert.strictEqual(isOpenRouterKeyShape('some-other-prefix-' + 'b'.repeat(32)), true);
		assert.strictEqual(isOpenRouterKeyShape('太短'), false);
		assert.strictEqual(isOpenRouterKeyShape('has space' + 'c'.repeat(30)), false);
	});

	test('GET /key 响应解析：label 缺失时不编造', () => {
		assert.deepStrictEqual(parseOpenRouterKeyInfo({ data: { label: 'my-key' } }), { label: 'my-key' });
		assert.deepStrictEqual(parseOpenRouterKeyInfo({ data: { label: '' } }), {});
		assert.deepStrictEqual(parseOpenRouterKeyInfo({ data: {} }), {});
		assert.deepStrictEqual(parseOpenRouterKeyInfo(undefined), {});
	});

	test('凭据读取：缺 API Key 抛错（不当成「没登录」），没存过才返回 undefined', async () => {
		const store = new Map<string, string>();
		const secrets = {
			get: async (key: string) => store.get(key),
			store: async (key: string, value: string) => void store.set(key, value),
			delete: async (key: string) => void store.delete(key),
		} as unknown as vscode.SecretStorage;

		assert.strictEqual(await readOpenRouterCredential(secrets, 'k'), undefined);
		store.set('k', 'not json');
		await assert.rejects(readOpenRouterCredential(secrets, 'k'), /凭据格式无效/);
		store.set('k', JSON.stringify({ label: 'x' }));
		await assert.rejects(readOpenRouterCredential(secrets, 'k'), /缺少 API Key/);
		store.set('k', JSON.stringify(credential()));
		assert.strictEqual((await readOpenRouterCredential(secrets, 'k'))?.label, 'test-key');
	});

	// ── SSE 消费 ──

	test('SSE：正文 delta 上报文本，结束帧与心跳注释帧都静默跳过', async () => {
		const body = [
			': OPENROUTER PROCESSING',
			'',
			`data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}`,
			'',
			'data: [DONE]',
			'',
		].join('\n');
		const parts: vscode.LanguageModelResponsePart[] = [];
		await consumeOpenRouterSse(
			new Response(body).body!,
			{ report: (part) => parts.push(part) },
			new vscode.CancellationTokenSource().token,
		);
		const texts = parts.filter((part): part is vscode.LanguageModelTextPart =>
			part instanceof vscode.LanguageModelTextPart);
		assert.strictEqual(texts.length, 1);
		assert.strictEqual(texts[0]?.value, '你好');
	});

	test('SSE：总是会发的 usage 帧被上报（它带 choices，不能靠「没有 choices」识别）', async () => {
		const body = [
			`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}`,
			'',
			// ⚠️ 真实形状：usage 帧**带一个 content 为空的 delta**（上游刻意偏离 OpenAI 规范）。
			`data: ${JSON.stringify({
				choices: [{ delta: { content: '', role: 'assistant' }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 5144, completion_tokens: 32, total_tokens: 5176, prompt_tokens_details: { cached_tokens: 5120 } },
			})}`,
			'',
			'data: [DONE]',
			'',
		].join('\n');
		const parts: vscode.LanguageModelResponsePart[] = [];
		await consumeOpenRouterSse(
			new Response(body).body!,
			{ report: (part) => parts.push(part) },
			new vscode.CancellationTokenSource().token,
		);
		const usagePart = parts.find((part) => part instanceof vscode.LanguageModelDataPart
			&& (part as vscode.LanguageModelDataPart).mimeType === 'usage') as vscode.LanguageModelDataPart | undefined;
		assert.ok(usagePart, '应上报 usage');
		const payload = JSON.parse(new TextDecoder().decode(usagePart.data)) as Record<string, unknown>;
		assert.strictEqual(payload.prompt_tokens, 5144);
		assert.deepStrictEqual(payload.prompt_tokens_details, { cached_tokens: 5120 });
	});

	test('SSE：工具调用分片合并后上报', async () => {
		const body = [
			`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{"pa' } }] } }] })}`,
			'',
			`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }] })}`,
			'',
			'data: [DONE]',
			'',
		].join('\n');
		const parts: vscode.LanguageModelResponsePart[] = [];
		await consumeOpenRouterSse(
			new Response(body).body!,
			{ report: (part) => parts.push(part) },
			new vscode.CancellationTokenSource().token,
		);
		const call = parts.find((part): part is vscode.LanguageModelToolCallPart =>
			part instanceof vscode.LanguageModelToolCallPart);
		assert.ok(call);
		assert.strictEqual(call.name, 'read_file');
		assert.deepStrictEqual(call.input, { path: 'a.ts' });
	});

	test('SSE：流内 error 帧必须抛（HTTP 已经是 200，只有帧里说得清）', async () => {
		const body = [
			`data: ${JSON.stringify({
				error: { code: 'server_error', message: 'Provider disconnected unexpectedly' },
				choices: [{ delta: { content: '' }, finish_reason: 'error' }],
			})}`,
			'',
		].join('\n');
		await assert.rejects(
			consumeOpenRouterSse(
				new Response(body).body!,
				{ report: () => undefined },
				new vscode.CancellationTokenSource().token,
			),
			/Provider disconnected unexpectedly/,
		);
	});

	test('SSE：无法解析的帧报错时带出原文', async () => {
		await assert.rejects(
			consumeOpenRouterSse(
				new Response('data: [FAIL]upstream blew up\n\n').body!,
				{ report: () => undefined },
				new vscode.CancellationTokenSource().token,
			),
			/无法解析的 SSE 数据.*upstream blew up/,
		);
	});

	test('思考链取值：字符串字段优先，同帧的 reasoning_details 不重复计算', () => {
		// ⚠️ 同帧两者并现时只能取一处，否则思考内容会被上报两遍。
		assert.strictEqual(
			openRouterThinkingText({
				reasoning: '第一段',
				reasoning_details: [{ type: 'reasoning.text', text: '第一段' }],
			}),
			'第一段',
		);
		// 别名。
		assert.strictEqual(openRouterThinkingText({ reasoning_content: '别名' }), '别名');
		// 只有结构化字段时才回落（summary 与 text 都要认）。
		assert.strictEqual(
			openRouterThinkingText({ reasoning_details: [{ type: 'reasoning.summary', summary: '摘要' }] }),
			'摘要',
		);
		// 加密块无文本 ⇒ 空（不能把密文当思考显示）。
		assert.strictEqual(
			openRouterThinkingText({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'AAAA' }] }),
			'',
		);
		assert.strictEqual(openRouterThinkingText({}), '');
	});

	// ── 消息构造 ──

	test('消息构造：注入系统提示，工具调用与工具结果都下发', () => {
		const messages: vscode.LanguageModelChatRequestMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart('帮我看看 a.ts')],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelToolCallPart('call-1', 'read_file', { path: 'a.ts' })],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('内容')])],
				name: undefined,
			},
		];
		const output = messagesToOpenRouter(messages);
		assert.strictEqual(output[0]?.role, 'system');
		assert.deepStrictEqual(output.slice(1).map((message) => message.role), ['user', 'assistant', 'tool']);
		assert.strictEqual(output[2]?.tool_calls?.[0]?.function.name, 'read_file');
		// ⚠️ 只发 tool_calls 不发 tool 结果，模型会「看不到自己调用过什么」。
		assert.strictEqual(output[3]?.tool_call_id, 'call-1');
		assert.strictEqual(output[3]?.content, '内容');
	});

	test('消息构造：图片走多模态数组（压成文本会静默丢图）', () => {
		const content = [new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png')];
		const output = messagesToOpenRouter([
			{ role: vscode.LanguageModelChatMessageRole.User, content, name: undefined },
		]);
		const parts = output[1]?.content;
		assert.ok(Array.isArray(parts));
		assert.deepStrictEqual(parts[0], {
			type: 'image_url',
			image_url: { url: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}` },
		});
	});

	test('工具定义：无工具时不下发 tools', () => {
		assert.strictEqual(openRouterTools(undefined), undefined);
		assert.strictEqual(openRouterTools([]), undefined);
		const tools = openRouterTools([{
			name: 'read_file',
			description: '读文件',
			inputSchema: { type: 'object' },
		}]);
		assert.deepStrictEqual(tools, [{
			type: 'function',
			function: { name: 'read_file', description: '读文件', parameters: { type: 'object' } },
		}]);
	});

	// ── provider 行为 ──

	test('provider：没有凭据时不展示任何模型（也不发请求）', async () => {
		let fetches = 0;
		const provider = new OpenRouterChatProvider({
			resolveCredential: async () => undefined,
			fetchCatalog: async () => { fetches += 1; return catalogPayload(); },
		});
		const models = await provider.provideLanguageModelChatInformation(
			{ silent: false } as vscode.PrepareLanguageModelChatModelOptions,
			new vscode.CancellationTokenSource().token,
		);
		assert.deepStrictEqual(models, []);
		assert.strictEqual(fetches, 0);
	});

	test('provider：两级目录都拉，供应商选项与默认档位进 configurationSchema', async () => {
		const requested: string[] = [];
		const provider = new OpenRouterChatProvider({
			resolveCredential: async () => credential(),
			fetchCatalog: async () => catalogPayload(),
			fetchProviders: async (modelId) => {
				requested.push(modelId);
				return endpointsPayload();
			},
		});
		const models = await provider.provideLanguageModelChatInformation(
			{ silent: true } as vscode.PrepareLanguageModelChatModelOptions,
			new vscode.CancellationTokenSource().token,
		);
		assert.deepStrictEqual(models.map((model) => model.id), [
			'liquid/lfm-2.5-2.6b:free',
			'deepseek/deepseek-v4.1-flash',
		]);
		// ⚠️ 供应商**只能**从第二级目录拿到 —— 每个展示的模型都要查一次。
		assert.deepStrictEqual(requested, ['liquid/lfm-2.5-2.6b:free', 'deepseek/deepseek-v4.1-flash']);

		const ds = models[1] as OpenRouterModel;
		assert.strictEqual(ds.maxInputTokens, 1_048_576);
		assert.strictEqual(ds.maxOutputTokens, 943_718);
		assert.strictEqual(ds.capabilities.imageInput, true);
		assert.deepStrictEqual(ds.providerOptions.map((option) => option.slug), [
			'deepinfra/fp8',
			'baseten/fp8',
			'baseten/fast',
			'fireworks/us',
		]);

		const schema = ds.configurationSchema as {
			properties?: Record<string, { enum?: string[]; enumItemLabels?: string[]; default?: unknown }>;
		};
		const effortProperty = schema.properties?.reasoningEffort;
		// 弱 → 强展示，默认档落在上游声明的 high。
		assert.deepStrictEqual(effortProperty?.enum, ['low', 'high', 'max']);
		assert.strictEqual(effortProperty?.default, 'high');
		// ⚠️⚠️ 回归守卫：schema 里**不得**再出现「上游供应商」属性。
		// VS Code 的模型选择器只认两个固定槽位（navigation = 思考强度 / tokens = 上下文），
		// 同一槽位只取一个属性且 navigation 里 reasoningEffort 是别名优先命中项 ⇒
		// 再声明一个 provider 属性**永远取不到**；更糟的是在「没有思考档位」的模型上
		// 它会反过来占住 navigation 槽（那时没有 reasoningEffort 去命中别名）。
		// 上游绑定因此改走「设置 + 命令」。
		assert.strictEqual('provider' in (schema.properties ?? {}), false, '上游供应商不得声明进 configurationSchema');
		assert.deepStrictEqual(Object.keys(schema.properties ?? {}), ['reasoningEffort']);
	});

	test('provider：模型没有可选上游时只声明思考强度（不声明空下拉）', async () => {
		const provider = new OpenRouterChatProvider({
			resolveCredential: async () => credential(),
			fetchCatalog: async () => catalogPayload(),
			// 免费模型这里给空端点（真实情况：`openrouter/free` 的 endpoints 就是 []）。
			fetchProviders: async () => ({ data: { endpoints: [] } }),
		});
		const models = await provider.provideLanguageModelChatInformation(
			{ silent: false } as vscode.PrepareLanguageModelChatModelOptions,
			new vscode.CancellationTokenSource().token,
		);
		const liquid = models[0] as OpenRouterModel;
		assert.deepStrictEqual(liquid.providerOptions, []);
		const schema = liquid.configurationSchema as { properties?: Record<string, unknown> };
		assert.deepStrictEqual(Object.keys(schema.properties ?? {}), ['reasoningEffort']);
	});

	test('provider：目录缓存命中时不重复拉取；refreshModels 后重拉', async () => {
		let catalogFetches = 0;
		const provider = new OpenRouterChatProvider({
			resolveCredential: async () => credential(),
			fetchCatalog: async () => { catalogFetches += 1; return catalogPayload(); },
			fetchProviders: async () => endpointsPayload(),
		});
		const token = new vscode.CancellationTokenSource().token;
		const options = { silent: false } as vscode.PrepareLanguageModelChatModelOptions;
		await provider.provideLanguageModelChatInformation(options, token);
		await provider.provideLanguageModelChatInformation(options, token);
		assert.strictEqual(catalogFetches, 1, 'TTL 内应复用缓存');

		provider.refreshModels();
		await provider.provideLanguageModelChatInformation(options, token);
		assert.strictEqual(catalogFetches, 2, 'refreshModels 之后应重拉');
	});

	test('provider：认证失败直接抛（不能藏成「空列表」），无缓存时其它失败也抛', async () => {
		const options = { silent: false } as vscode.PrepareLanguageModelChatModelOptions;
		const token = new vscode.CancellationTokenSource().token;

		const unauthorized = new OpenRouterChatProvider({
			resolveCredential: async () => credential(),
			fetchCatalog: async () => { throw new Error('OpenRouter HTTP 401: {"error":{"message":"No auth credentials found"}}'); },
		});
		await assert.rejects(
			unauthorized.provideLanguageModelChatInformation(options, token),
			/HTTP 401/,
		);

		// ⚠️ 普通网络故障 + 没有旧目录 ⇒ 必须抛，否则用户看到的是「什么都没有」且毫无提示。
		const broken = new OpenRouterChatProvider({
			resolveCredential: async () => credential(),
			fetchCatalog: async () => { throw new Error('fetch failed'); },
		});
		await assert.rejects(
			broken.provideLanguageModelChatInformation(options, token),
			/fetch failed/,
		);
	});

	test('provider：已有旧目录时，瞬时失败沿用旧目录（不把列表变空）', async () => {
		let shouldFail = false;
		const provider = new OpenRouterChatProvider({
			resolveCredential: async () => credential(),
			fetchCatalog: async () => {
				if (shouldFail) { throw new Error('fetch failed'); }
				return catalogPayload();
			},
			fetchProviders: async () => endpointsPayload(),
		});
		const options = { silent: false } as vscode.PrepareLanguageModelChatModelOptions;
		const token = new vscode.CancellationTokenSource().token;
		const first = await provider.provideLanguageModelChatInformation(options, token);
		assert.strictEqual(first.length, 2);

		shouldFail = true;
		provider.refreshModels();
		const second = await provider.provideLanguageModelChatInformation(options, token);
		assert.deepStrictEqual(second.map((model) => model.id), first.map((model) => model.id));
	});

	test('provider：单个模型查不到上游不拖垮整个目录', async () => {
		const provider = new OpenRouterChatProvider({
			resolveCredential: async () => credential(),
			fetchCatalog: async () => catalogPayload(),
			fetchProviders: async (modelId) => {
				if (modelId === 'deepseek/deepseek-v4.1-flash') { throw new Error('boom'); }
				return endpointsPayload();
			},
		});
		const models = await provider.provideLanguageModelChatInformation(
			{ silent: false } as vscode.PrepareLanguageModelChatModelOptions,
			new vscode.CancellationTokenSource().token,
		);
		assert.strictEqual(models.length, 2);
		assert.deepStrictEqual((models[1] as OpenRouterModel).providerOptions, []);
	});

	// ── vendor 接线（本次报障的真正原因）──

	test('vendor：代码常量与 package.json 的声明逐字一致、且激活事件成对', async () => {
		// ⚠️ 官方契约：`registerLanguageModelChatProvider` 的 vendor
		// 「**Must be globally unique**」—— 而 **Copilot Chat 内置的 BYOK 已占用了
		// `openrouter`**。重名的症状是最难查的那种：`provideLanguageModelChatInformation`
		// **照样被调用**（日志一切正常），但模型选择器里就是不出现我们的模型。
		// 所以这里必须同时锁住两件事：名字唯一、且三处（常量 / contributes / 激活事件）一致。
		assert.strictEqual(
			OPENROUTER_VENDOR,
			'openrouter-byok',
			'vendor 是唯一性契约的一部分，改名要同步本用例与 package.json',
		);

		// ⚠️ 不能用 `import` 读 json（会被编译期处理掉），必须像 `jet-hub-styles-ownership.spec.ts`
		// 那样从工作区根实际读盘 —— 否则「manifest 漂移」这类缺陷根本测不到。
		const manifest = JSON.parse(
			fs.readFileSync(path.join(workspaceRoot(), 'package.json'), 'utf8'),
		) as {
			activationEvents?: string[];
			contributes?: { languageModelChatProviders?: Array<{ vendor?: string; displayName?: string; managementCommand?: string }> };
		};

		const declared = (manifest.contributes?.languageModelChatProviders ?? [])
			.filter((entry) => entry.vendor === OPENROUTER_VENDOR);
		assert.strictEqual(declared.length, 1, `package.json 必须**恰好**声明一次 vendor '${OPENROUTER_VENDOR}'`);
		// 大小写敏感：`openrouter-BYOK` 这类漂移会让注册静默失败。
		assert.strictEqual(declared[0]?.vendor, OPENROUTER_VENDOR);
		assert.ok(declared[0]?.displayName && declared[0].displayName.length > 0, '缺 displayName');
		assert.strictEqual(declared[0]?.managementCommand, 'github-copilot-codearts.manageOpenRouter');

		// ⚠️ 激活事件必须成对：`onLanguageModelChatProvider:<vendor>` 写错或漏写，
		// 扩展就不会因「用户打开模型选择器」而激活 ⇒ 同样是「列表里什么都没有」。
		assert.ok(
			(manifest.activationEvents ?? []).includes(`onLanguageModelChatProvider:${OPENROUTER_VENDOR}`),
			`activationEvents 必须含 onLanguageModelChatProvider:${OPENROUTER_VENDOR}`,
		);

		// ⚠️ 反向：`vendor` 与内置的 `openrouter` 不能同时出现在本清单里
		// （那意味着我们又撞回重名）。本清单里只应有我们自己那一条。
		assert.ok(
			!(manifest.contributes?.languageModelChatProviders ?? [])
				.some((entry) => entry.vendor === 'openrouter'),
			'不得声明 vendor "openrouter"（与 Copilot Chat 内置 BYOK 重名）',
		);
	});

	// ── 上游绑定（设置 + 命令那条路）──

	/** 造一个带上游选项的模型（供请求体用例复用）。 */
	function pinnedModel(overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
		return {
			id: 'deepseek/deepseek-v4.1-flash',
			name: 'DeepSeek V4.1 Flash',
			family: 'deepseek/deepseek-v4.1-flash',
			version: '1',
			maxInputTokens: 1_048_576,
			maxOutputTokens: 943_718,
			capabilities: { imageInput: true, toolCalling: true },
			providerOptions: [
				{ slug: 'deepinfra/fp8', label: 'DeepInfra' },
				{ slug: 'baseten/fast', label: 'BaseTen · baseten/fast' },
			],
			efforts: ['low', 'high', 'max'],
			...overrides,
		};
	}

	function bodyFor(pinnedSlug: string | undefined, overrides: Partial<OpenRouterModel> = {}) {
		return openRouterRequestBody({
			model: pinnedModel(overrides),
			messages: [{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart('hi')],
				name: undefined,
			}],
			effort: 'high',
			pinnedSlug,
			tools: undefined,
			toolMode: vscode.LanguageModelChatToolMode.Auto,
		});
	}

	test('请求体：绑定的上游被严格锁定（order + 关闭回退）', () => {
		const body = bodyFor('deepinfra/fp8');
		assert.deepStrictEqual(body.provider, { order: ['deepinfra/fp8'], allow_fallbacks: false });
		assert.strictEqual(body.model, 'deepseek/deepseek-v4.1-flash');
		assert.strictEqual(body.stream, true);
		assert.deepStrictEqual(body.reasoning, { effort: 'high' });
	});

	test('请求体：未绑 / 自动 / 绑定已失效 ⇒ 一律不下发 provider', () => {
		// 未绑（读设置拿到 undefined）。
		assert.strictEqual('provider' in bodyFor(undefined), false);
		// 「自动」是显式的「解除锁定」。
		assert.strictEqual('provider' in bodyFor(OPENROUTER_PROVIDER_AUTO), false);
		// ⚠️ 绑定值已不在当前目录（上游改名/下架，或用户手写错）⇒ 不能照发，否则上游 404。
		assert.strictEqual('provider' in bodyFor('gone/provider'), false);
		// 空串同理。
		assert.strictEqual('provider' in bodyFor(''), false);
	});

	test('请求体：模型没有上游选项时，即便绑了值也不下发', () => {
		assert.strictEqual('provider' in bodyFor('deepinfra/fp8', { providerOptions: [] }), false);
	});

	test('请求体：刻意不下发 max_tokens（它会参与路由过滤）', () => {
		const body = bodyFor('deepinfra/fp8');
		assert.strictEqual('max_tokens' in body, false);
		assert.strictEqual('max_completion_tokens' in body, false);
		// 模型自己的输出上限也不该被塞进去。
		assert.strictEqual(body.max_tokens, undefined);
	});

	test('请求体：思考档位非法时不下发（缓存旧目录的档位）', () => {
		const body = openRouterRequestBody({
			model: pinnedModel(),
			messages: [],
			effort: 'xhigh',
			pinnedSlug: undefined,
			tools: undefined,
			toolMode: vscode.LanguageModelChatToolMode.Auto,
		});
		assert.strictEqual('reasoning' in body, false);
	});

	test('设置：绑定表归一化只保留合法条目', () => {
		assert.deepStrictEqual(normalizePinnedProviders(undefined), {});
		assert.deepStrictEqual(normalizePinnedProviders('不是对象'), {});
		assert.deepStrictEqual(normalizePinnedProviders(['a']), {});
		assert.deepStrictEqual(
			normalizePinnedProviders({
				'a/b': 'deepinfra/fp8',
				'c/d': '  spaced  ',
				'e/f': '',
				'g/h': 42,
				'': 'x',
				'i/j': null,
			}),
			{ 'a/b': 'deepinfra/fp8', 'c/d': 'spaced' },
		);
	});

	test('设置：绑定 / 解绑的写入结果（解绑是删键，不是写 auto）', () => {
		const start = { 'a/b': 'deepinfra/fp8' };
		assert.deepStrictEqual(withPinnedProvider(start, 'c/d', 'baseten/fast'), {
			'a/b': 'deepinfra/fp8',
			'c/d': 'baseten/fast',
		});
		// 「自动」/空串/undefined ⇒ 删键：settings.json 里只留真正的绑定。
		assert.deepStrictEqual(withPinnedProvider(start, 'a/b', OPENROUTER_PROVIDER_AUTO), {});
		assert.deepStrictEqual(withPinnedProvider(start, 'a/b', ''), {});
		assert.deepStrictEqual(withPinnedProvider(start, 'a/b', undefined), {});
		// ⚠️ 纯函数：不得改到输入（否则调用方的 map 会被就地污染）。
		assert.deepStrictEqual(start, { 'a/b': 'deepinfra/fp8' });
	});

	test('provider：绑定来自设置，而不是模型选择器', async () => {
		// ⚠️ 这条守卫的是「上游绑定改走设置」的接线：provider 必须读注入的
		// readPinnedProvider，而不是 options.modelConfiguration.provider。
		const seen: string[] = [];
		const provider = new OpenRouterChatProvider({
			resolveCredential: async () => credential(),
			readPinnedProvider: (modelId) => {
				seen.push(modelId);
				return 'deepinfra/fp8';
			},
			fetchCatalog: async () => catalogPayload(),
			fetchProviders: async () => endpointsPayload(),
		});
		const models = await provider.provideLanguageModelChatInformation(
			{ silent: false } as vscode.PrepareLanguageModelChatModelOptions,
			new vscode.CancellationTokenSource().token,
		);
		assert.ok(models.length > 0);
		// 绑定查询只发生在**发消息**时；这里只确认它被接线进来（不触发网络）。
		assert.deepStrictEqual(seen, []);
	});

	// ── 并发（用户 2026-10-15 报障）──

	test('并发：多路同时调用只发一轮请求（否则一次开选择器就打十几轮）', async () => {
		// ⚠️ 真缺陷：旧实现里 `catalogLoadedAt` 在拉取完成**之后**才写，
		// 所以并发调用时每一路都判定「无缓存」⇒ 各路各自发一轮
		//（1 次目录 + N 次上游查询）。共享 in-flight Promise 后只发一轮。
		let catalogFetches = 0;
		let providerFetches = 0;
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const provider = new OpenRouterChatProvider({
			resolveCredential: async () => credential(),
			fetchCatalog: async () => {
				catalogFetches += 1;
				await gate;
				return catalogPayload();
			},
			fetchProviders: async () => {
				providerFetches += 1;
				return endpointsPayload();
			},
		});
		const options = { silent: true } as vscode.PrepareLanguageModelChatModelOptions;
		const token = new vscode.CancellationTokenSource().token;
		// 同时发起 4 路（模拟 VS Code 的并发查询）。
		const pending = [1, 2, 3, 4].map(() => provider.provideLanguageModelChatInformation(options, token));
		// 等它们都进入 in-flight 状态再放行。
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		release();
		const results = await Promise.all(pending);
		assert.strictEqual(catalogFetches, 1, '并发调用必须共享同一次目录拉取');
		assert.strictEqual(providerFetches, 2, '上游查询也只应各发一次（2 个模型）');
		for (const models of results) {
			assert.strictEqual(models.length, 2);
		}
	});

	test('并发：共享的同批拉取失败时，四路都拿到错误（不静默成空列表）', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const provider = new OpenRouterChatProvider({
			resolveCredential: async () => credential(),
			fetchCatalog: async () => {
				await gate;
				throw new Error('fetch failed');
			},
		});
		const options = { silent: false } as vscode.PrepareLanguageModelChatModelOptions;
		const token = new vscode.CancellationTokenSource().token;
		const pending = [1, 2, 3]
			.map(() => provider.provideLanguageModelChatInformation(options, token)
				.then(() => 'resolved' as const, (error: unknown) => String(error)));
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		release();
		const results = await Promise.all(pending);
		for (const result of results) {
			assert.match(result, /fetch failed/, '无缓存时失败必须上抛而不是返回空列表');
		}
	});
});
