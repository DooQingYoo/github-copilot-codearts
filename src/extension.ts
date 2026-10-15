// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { loginCodeBuddy } from './codebuddy-auth';
import { CodeBuddyChatProvider } from './codebuddy-provider';
import { loginQoderCn } from './qoder-cn-auth';
import { createQoderCnProvider } from './qoder-cn-provider';
import { loginTrae } from './trae-auth';
import { createTraeProvider } from './trae-provider';
import { clearOpenRouterCredential, loginOpenRouter, readOpenRouterCredential } from './openrouter-auth';
import { OPENROUTER_PROVIDER_AUTO_LABEL } from './openrouter';
import { OPENROUTER_VENDOR, createOpenRouterProvider, type OpenRouterModel } from './openrouter-provider';
import { readPinnedProviders, savePinnedProviders, withPinnedProvider } from './openrouter-settings';

const CODEBUDDY_CREDENTIAL_KEY = 'github-copilot-codearts.codebuddy';
const QODER_CN_CREDENTIAL_KEY = 'github-copilot-codearts.qodercn';
const TRAE_CREDENTIAL_KEY = 'github-copilot-codearts.trae';
const OPENROUTER_CREDENTIAL_KEY = 'github-copilot-codearts.openrouter';

export function activate(context: vscode.ExtensionContext): void {
	const codeBuddyProvider = new CodeBuddyChatProvider(context.secrets, CODEBUDDY_CREDENTIAL_KEY);
	const qoderCnProvider = createQoderCnProvider(context.secrets, QODER_CN_CREDENTIAL_KEY);

	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider('codebuddy', codeBuddyProvider),
		codeBuddyProvider,
		vscode.commands.registerCommand('github-copilot-codearts.manageCodeBuddy', async () => {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: '正在连接 CodeBuddy', cancellable: true },
				async (_progress, token) => {
					try {
						await loginCodeBuddy(context.secrets, CODEBUDDY_CREDENTIAL_KEY, token);
						await codeBuddyProvider.refreshModels();
						void vscode.window.showInformationMessage('CodeBuddy 已连接。现在可以在 Copilot Chat 的模型选择器中选择 CodeBuddy。');
					} catch (error) {
						if (!token.isCancellationRequested) {
							void vscode.window.showErrorMessage(`CodeBuddy 登录失败：${error instanceof Error ? error.message : String(error)}`);
						}
					}
				},
			);
		}),
		vscode.commands.registerCommand('github-copilot-codearts.logoutCodeBuddy', async () => {
			await context.secrets.delete(CODEBUDDY_CREDENTIAL_KEY);
			await codeBuddyProvider.refreshModels();
			void vscode.window.showInformationMessage('已从此 VS Code 配置中移除 CodeBuddy 凭据。');
		}),
	);

	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider('qodercn', qoderCnProvider),
		qoderCnProvider,
		vscode.commands.registerCommand('github-copilot-codearts.manageQoderCn', async () => {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: '正在连接 Qoder (中国版)', cancellable: true },
				async (progress, token) => {
					try {
						progress.report({ message: '已打开浏览器授权页，请在浏览器中完成授权…' });
						await loginQoderCn(context.secrets, QODER_CN_CREDENTIAL_KEY, token);
						qoderCnProvider.refreshModels();
						void vscode.window.showInformationMessage('Qoder (中国版) 已连接。现在可以在 Copilot Chat 的模型选择器中选择 Qoder 中国版。');
					} catch (error) {
						if (!token.isCancellationRequested) {
							void vscode.window.showErrorMessage(`Qoder (中国版) 登录失败：${error instanceof Error ? error.message : String(error)}`);
						}
					}
				},
			);
		}),
		vscode.commands.registerCommand('github-copilot-codearts.logoutQoderCn', async () => {
			await context.secrets.delete(QODER_CN_CREDENTIAL_KEY);
			qoderCnProvider.refreshModels();
			void vscode.window.showInformationMessage('已从此 VS Code 配置中移除 Qoder (中国版) 凭据。');
		}),
	);

	const traeProvider = createTraeProvider(context.secrets, TRAE_CREDENTIAL_KEY);

	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider('trae', traeProvider),
		traeProvider,
		vscode.commands.registerCommand('github-copilot-codearts.manageTrae', async () => {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: '正在连接 TRAE (字节)', cancellable: true },
				async (progress, token) => {
					try {
						progress.report({ message: '已打开浏览器授权页，请在浏览器中完成授权…' });
						await loginTrae(context.secrets, TRAE_CREDENTIAL_KEY, token);
						traeProvider.refreshModels();
						void vscode.window.showInformationMessage('TRAE (字节) 已连接。现在可以在 Copilot Chat 的模型选择器中选择 TRAE。');
					} catch (error) {
						if (!token.isCancellationRequested) {
							void vscode.window.showErrorMessage(`TRAE (字节) 登录失败：${error instanceof Error ? error.message : String(error)}`);
						}
					}
				},
			);
		}),
		vscode.commands.registerCommand('github-copilot-codearts.logoutTrae', async () => {
			await context.secrets.delete(TRAE_CREDENTIAL_KEY);
			traeProvider.refreshModels();
			void vscode.window.showInformationMessage('已从此 VS Code 配置中移除 TRAE (字节) 凭据。');
		}),
	);

	const openRouterProvider = createOpenRouterProvider(context.secrets, OPENROUTER_CREDENTIAL_KEY);

	// ⚠️ 注册失败**必须留痕**：vendor 与 `package.json` 的声明不一致、或与其它扩展
	// 重名时，这一步是**静默**失败的，而症状恰好是「模型列表里什么都没有」
	// ——正是 2026-10-15 那次报障。这里只记错误路径（正常路径零输出），
	// 走 Extension Host 的标准错误通道而不另建 Output 面板。
	try {
		context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(OPENROUTER_VENDOR, openRouterProvider));
	} catch (error) {
		console.error(`[github-copilot-codearts] 注册 OpenRouter provider 失败（vendor='${OPENROUTER_VENDOR}'）：`,
			error instanceof Error ? error.message : String(error));
	}

	context.subscriptions.push(
		openRouterProvider,
		// ⚠️ OpenRouter 没有浏览器登录流程（只有粘贴 API Key），
		// 所以这里**不**包 `withProgress`：进度通知叠在输入框上只是噪声。
		vscode.commands.registerCommand('github-copilot-codearts.manageOpenRouter', async () => {
			try {
				const credential = await loginOpenRouter(context.secrets, OPENROUTER_CREDENTIAL_KEY);
				if (credential === undefined) {
					return;
				}
				openRouterProvider.refreshModels();
				const label = credential.label === undefined ? '' : `（${credential.label}）`;
				void vscode.window.showInformationMessage(`OpenRouter 已连接${label}。现在可以在 Copilot Chat 的模型选择器中选择 OpenRouter。`);
			} catch (error) {
				void vscode.window.showErrorMessage(`OpenRouter 设置失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}),
		vscode.commands.registerCommand('github-copilot-codearts.logoutOpenRouter', async () => {
			await clearOpenRouterCredential(context.secrets, OPENROUTER_CREDENTIAL_KEY);
			openRouterProvider.refreshModels();
			void vscode.window.showInformationMessage('已从此 VS Code 配置中移除 OpenRouter API Key。');
		}),
		// 上游供应商绑定：**不在模型选择器里选**（VS Code 只给两个固定配置槽位，
		// 且借用「上下文」槽会导致显示错误价格 —— 依据见 `openrouter-settings.ts`），
		// 改走本命令两步式选择 + 写入 VS Code 设置。
		vscode.commands.registerCommand('github-copilot-codearts.pickOpenRouterProvider', async () => {
			try {
				// 没登录就先引导登录（否则列表是空的，用户会以为命令坏了）。
				const credential = await readOpenRouterCredential(context.secrets, OPENROUTER_CREDENTIAL_KEY);
				if (credential === undefined) {
					const created = await loginOpenRouter(context.secrets, OPENROUTER_CREDENTIAL_KEY);
					if (created === undefined) {
						return;
					}
					openRouterProvider.refreshModels();
				}
				// ⚠️ 必须确保目录已加载：模型列表与上游选项都来自它。
				let models = openRouterProvider.listModels();
				if (models.length === 0) {
					await openRouterProvider.provideLanguageModelChatInformation(
						{ silent: true } as vscode.PrepareLanguageModelChatModelOptions,
						// ⚠️ 这里能给一个「永不取消」的令牌：命令本身没有 CancellationToken。
						new vscode.CancellationTokenSource().token,
					);
					models = openRouterProvider.listModels();
				}
				if (models.length === 0) {
					void vscode.window.showWarningMessage('OpenRouter 模型目录为空，无法设置上游供应商。请先设置 API Key。');
					return;
				}
				const map = readPinnedProviders();
				const modelPick = await vscode.window.showQuickPick(
					models.map((model) => ({
						label: model.name,
						description: map[model.id] === undefined
							? `自动（${model.providerOptions.length} 个可选上游）`
							: `已锁定：${providerLabelOf(model, map[model.id] ?? '')}`,
						detail: model.id,
						modelId: model.id,
					})),
					{ title: '选择要设置上游供应商的模型', placeHolder: '先选模型', matchOnDetail: true },
				);
				if (modelPick === undefined) {
					return;
				}
				const chosen = models.find((model) => model.id === modelPick.modelId);
				if (chosen === undefined) {
					return;
				}
				if (chosen.providerOptions.length === 0) {
					void vscode.window.showInformationMessage(
						`「${chosen.name}」当前没有可选的上下游（该模型的上游端点列表为空），只能走自动路由。`,
					);
					return;
				}
				const providerPick = await vscode.window.showQuickPick(
					[
						{
							label: OPENROUTER_PROVIDER_AUTO_LABEL,
							description: '解除锁定，交回 OpenRouter 按价格负载均衡',
							slug: undefined as string | undefined,
						},
						...chosen.providerOptions.map((option) => ({
							label: option.label,
							description: `${option.slug}（严格只用它，不回退）`,
							slug: option.slug as string | undefined,
						})),
					],
					{ title: `「${chosen.name}」的上游供应商`, placeHolder: '默认：自动' },
				);
				if (providerPick === undefined) {
					return;
				}
				const next = withPinnedProvider(map, chosen.id, providerPick.slug);
				await savePinnedProviders(next);
				const shown = providerPick.slug === undefined
					? '自动（负载均衡）'
					: `${providerPick.label}（严格锁定，不回退）`;
				void vscode.window.showInformationMessage(`已将「${chosen.name}」的上游供应商设为：${shown}`);
			} catch (error) {
				void vscode.window.showErrorMessage(`设置上游供应商失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}),
	);
}

/** 把 slug 翻成给人看的标签（找不到则原样显示 slug，便于用户自查拼写）。 */
function providerLabelOf(model: OpenRouterModel, slug: string): string {
	return model.providerOptions.find((option) => option.slug === slug)?.label ?? slug;
}
