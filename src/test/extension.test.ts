import * as assert from 'assert';
import * as vscode from 'vscode';
import { credentialExpiresAtMs } from '../codebuddy-auth';
import { codeBuddyEffortsFor, consumeSse, mergeCodeBuddyModels, messagesToOpenAi, parseCodeBuddyModels } from '../codebuddy-provider';

suite('Extension Test Suite', () => {
	test('只展示 CodeBuddy 对话目录中的可用模型', () => {
		const models = parseCodeBuddyModels({
			data: {
				agents: [
					{ name: 'ask', models: ['ask-only'] },
					{ name: 'craft', models: ['work-model', 'completion-noise', 'auto'] },
				],
				models: [
					{ id: 'work-model', name: 'Work Model', maxInputTokens: 100_000, maxOutputTokens: 8_000, supportsImages: true },
					{ id: 'completion-noise', maxOutputTokens: 128 },
					{ id: 'ask-only', name: 'Ask only' },
					{ id: 'image-generation', tags: ['text-to-image'] },
				],
			},
		});

		assert.deepStrictEqual(models.map((model) => model.id), ['work-model', 'ask-only']);
		assert.strictEqual(models[0]?.maxInputTokens, 100_000);
		assert.strictEqual(models[0]?.capabilities.imageInput, true);
		assert.strictEqual(models[0]?.capabilities.toolCalling, true);
	});

	test('思考档位：有档位的模型才声明 reasoningEffort，默认档落在枚举内', () => {
		const models = parseCodeBuddyModels({
			data: {
				agents: [{ name: 'cli', models: ['deepseek-v4-pro', 'glm-5.3', 'unknown-model'] }],
				models: [
					{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
					{ id: 'glm-5.3', name: 'GLM-5.3' },
					{ id: 'unknown-model', name: 'Unknown' },
				],
			},
		});
		const byId = new Map(models.map((model) => [model.id, model]));

		const pro = byId.get('deepseek-v4-pro');
		assert.ok(pro?.configurationSchema, 'deepseek-v4-pro 应暴露思考档位');
		const proProp = pro.configurationSchema.properties?.reasoningEffort;
		assert.deepStrictEqual([...(proProp?.enum ?? [])], ['low', 'high', 'xhigh']);
		assert.strictEqual(proProp?.default, 'xhigh');
		assert.strictEqual((proProp?.enumItemLabels ?? [])[0], '低');

		// ⚠️ 目录外的模型不得凭空声明档位（否则用户会选到一个上游不认的值 → 400）。
		assert.strictEqual(byId.get('unknown-model')?.configurationSchema, undefined);
	});

	test('CodeBuddy 兜底目录也为模型声明思考档位', () => {
		// 远端目录不可用时会回退到兜底表，兜底表同样不能丢掉选择器。
		const models = parseCodeBuddyModels('not-an-object');
		for (const model of models) {
			assert.strictEqual(
				model.configurationSchema !== undefined,
				codeBuddyEffortsFor(model.id).length > 0,
				`${model.id} 的 schema 应与档位表一致`,
			);
		}
	});

	test('合并 CodeBuddy 双目录且保留 scoped 模型优先级', () => {
		const [primary, extra] = parseCodeBuddyModels({
			data: {
				agents: [{ name: 'cli', models: ['shared', 'primary-only'] }],
				models: [{ id: 'shared', name: 'Primary name' }, { id: 'primary-only' }],
			},
		});
		const [additional, configOnly] = parseCodeBuddyModels({
			data: {
				agents: [{ name: 'craft', models: ['shared', 'config-only'] }],
				models: [{ id: 'shared', name: 'Config name' }, { id: 'config-only' }],
			},
		});

		assert.ok(primary);
		assert.ok(extra);
		assert.ok(additional);
		assert.ok(configOnly);
		const merged = mergeCodeBuddyModels([primary, extra], [additional, configOnly]);
		assert.deepStrictEqual(merged.map((model) => model.id), ['shared', 'primary-only', 'config-only']);
		assert.strictEqual(merged[0]?.name, 'Primary name');
	});

	test('转换工具往返、图片和 CodeBuddy system 首条消息', () => {
		const messages = messagesToOpenAi([
			new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
				new vscode.LanguageModelTextPart('Main branch (you will usually use this for PRs)'),
				new vscode.LanguageModelToolCallPart('call-1', 'read_file', { path: 'src/main.ts' }),
			]),
			new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart('请看这张图'),
				vscode.LanguageModelDataPart.image(Uint8Array.from([1, 2, 3]), 'image/png'),
				new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('工具结果')]),
			]),
		]);

		assert.strictEqual(messages[0]?.role, 'system');
		assert.ok(messages[1]?.content?.includes('Main branch (PRs usually go here)'));
		assert.strictEqual(messages[1]?.tool_calls?.[0]?.function.name, 'read_file');
		assert.strictEqual(messages[2]?.role, 'user');
		assert.ok(Array.isArray(messages[2]?.content));
		assert.strictEqual(messages[3]?.role, 'tool');
		assert.strictEqual(messages[3]?.tool_call_id, 'call-1');
	});

	test('不改写用户消息里的 CodeBuddy 风控字面量', () => {
		const messages = messagesToOpenAi([
			new vscode.LanguageModelChatMessage(
				vscode.LanguageModelChatMessageRole.User,
				'Main branch (you will usually use this for PRs)',
			),
		]);
		assert.strictEqual(messages[0]?.role, 'system');
		assert.strictEqual(messages[1]?.content, 'Main branch (you will usually use this for PRs)');
	});

	test('解析 CodeBuddy 令牌的秒、毫秒和 ISO 到期时间', () => {
		const token = { access_token: 'not-a-jwt', refresh_token: '' };
		assert.strictEqual(credentialExpiresAtMs({ ...token, expires_at: '1700000000' }), 1_700_000_000_000);
		assert.strictEqual(credentialExpiresAtMs({ ...token, expires_at: '1700000000000' }), 1_700_000_000_000);
		assert.strictEqual(credentialExpiresAtMs({ ...token, expires_at: '2023-11-14T22:13:20.000Z' }), 1_700_000_000_000);
	});

	test('将 CodeBuddy 无 choices 的 SSE 业务错误作为失败处理', async () => {
		const response = new Response('data: {"code":11128,"msg":"request rejected"}\n\n');
		await assert.rejects(
			consumeSse(response.body!, { report: () => undefined }, new vscode.CancellationTokenSource().token),
			/request rejected/,
		);
	});
});
