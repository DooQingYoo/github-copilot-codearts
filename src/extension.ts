// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { loginCodeBuddy } from './codebuddy-auth';
import { CodeBuddyChatProvider } from './codebuddy-provider';
import { loginQoderCn } from './qoder-cn-auth';
import { createQoderCnProvider } from './qoder-cn-provider';

const CODEBUDDY_CREDENTIAL_KEY = 'github-copilot-codearts.codebuddy';
const QODER_CN_CREDENTIAL_KEY = 'github-copilot-codearts.qodercn';

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
}
