import * as vscode from 'vscode';
import { readCodeBuddyCredential, type CodeBuddyCredential } from './codebuddy-auth';

const API = 'https://copilot.tencent.com';
const DOMAIN = 'copilot.tencent.com';
const USER_AGENT = 'CodeBuddyIDE/1.106.1';
const CATALOG_TTL_MS = 5 * 60_000;

interface CodeBuddyModel extends vscode.LanguageModelChatInformation {
	readonly id: string;
}

interface OpenAiMessage {
	role: string;
	content?: string | Array<string | { type: 'image_url'; image_url: { url: string } }>;
	tool_call_id?: string;
	tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

interface PendingToolCall {
	id: string;
	name: string;
	arguments: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function textFrom(value: unknown): string {
	if (typeof value === 'string') {return value;}
	if (!Array.isArray(value)) {return '';}
	return value.map((part) => {
		if (!isRecord(part)) {return '';}
		if (part instanceof vscode.LanguageModelTextPart) {return part.value;}
		if (part instanceof vscode.LanguageModelDataPart && !part.mimeType.startsWith('image/')) {
			return new TextDecoder().decode(part.data);
		}
		return typeof part.value === 'string' ? part.value : '';
	}).join('');
}

export function messagesToOpenAi(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAiMessage[] {
	const output: OpenAiMessage[] = [{ role: 'system', content: 'You are an AI coding assistant. Follow the conversation instructions and use the provided tools when appropriate.' }];
	for (const message of messages) {
		const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
		const content: Array<string | { type: 'image_url'; image_url: { url: string } }> = [];
		const toolCalls: NonNullable<OpenAiMessage['tool_calls']> = [];
		const toolResults: OpenAiMessage[] = [];
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				content.push(part.value);
				continue;
			}
			if (part instanceof vscode.LanguageModelDataPart) {
				if (part.mimeType.startsWith('image/')) {
					const encoded = Buffer.from(part.data).toString('base64');
					content.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${encoded}` } });
				} else {
					content.push(new TextDecoder().decode(part.data));
				}
				continue;
			}
			if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: { name: part.name, arguments: JSON.stringify(part.input) },
				});
				continue;
			}
			if (part instanceof vscode.LanguageModelToolResultPart) {
				toolResults.push({ role: 'tool', tool_call_id: part.callId, content: textFrom(part.content) });
				continue;
			}
			if (isRecord(part) && typeof part.value === 'string') {content.push(part.value);}
		}
		if (content.length > 0 || toolCalls.length > 0) {
			const textOnly = content.every((part): part is string => typeof part === 'string');
			const mergedContent = textOnly ? content.join('') : content;
			const normalizedContent = role === 'assistant'
				? rewriteCodeBuddyFingerprint(typeof mergedContent === 'string' ? mergedContent : '')
				: mergedContent;
			output.push({
				role,
				content: normalizedContent,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
		}
		output.push(...toolResults);
	}
	return output;
}

export function parseCodeBuddyModels(payload: unknown): CodeBuddyModel[] {
	if (!isRecord(payload) || !isRecord(payload.data)) {return fallbackModels();}
	const data = payload.data;
	const metadata = new Map<string, Record<string, unknown>>();
	if (Array.isArray(data.models)) {
		for (const item of data.models) {
			if (isRecord(item) && typeof item.id === 'string') {metadata.set(item.id, item);}
		}
	}
	const ids: string[] = [];
	const seen = new Set<string>();
	if (Array.isArray(data.agents)) {
		for (const preferredName of ['cli', 'craft']) {
			for (const agent of data.agents) {
				if (!isRecord(agent) || agent.name !== preferredName || !Array.isArray(agent.models)) {continue;}
				for (const id of agent.models) {
					if (typeof id === 'string' && !seen.has(id)) {
						seen.add(id);
						ids.push(id);
					}
				}
			}
		}
	}
	for (const id of metadata.keys()) {
		if (!seen.has(id)) {ids.push(id);}
	}
	const features = data.productFeaturesConfig;
	if (isRecord(features) && isRecord(features.ModelTrialBanner) && Array.isArray(features.ModelTrialBanner.banners)) {
		for (const banner of features.ModelTrialBanner.banners) {
			if (!isRecord(banner) || typeof banner.targetModelId !== 'string' || seen.has(banner.targetModelId)) {continue;}
			ids.push(banner.targetModelId);
		}
	}
	const models = ids.flatMap((id) => {
		const meta = metadata.get(id);
		if (id === 'auto' || id === 'default' || (Array.isArray(meta?.tags) && meta.tags.includes('text-to-image'))) {return [];}
		const name = typeof meta?.name === 'string' ? meta.name : id;
		if (id.startsWith('nes-') || id.startsWith('completion-') || id.startsWith('codewise-')) {return [];}
		if (meta?.supportsExtra === true || (typeof meta?.maxOutputTokens === 'number' && meta.maxOutputTokens > 0 && meta.maxOutputTokens <= 256)) {return [];}
		const inputTokens = numeric(meta?.maxInputTokens, 128_000);
		const outputTokens = numeric(meta?.maxOutputTokens, 16_000);
		return [{
			id,
			name,
			family: id,
			version: '1',
			maxInputTokens: inputTokens,
			maxOutputTokens: outputTokens,
			detail: 'CodeBuddy',
			capabilities: { imageInput: meta?.supportsImages === true, toolCalling: true },
		} satisfies CodeBuddyModel];
	});
	return models.length > 0 ? models : fallbackModels();
}

export function mergeCodeBuddyModels(
	preferred: readonly CodeBuddyModel[],
	additional: readonly CodeBuddyModel[],
): CodeBuddyModel[] {
	const ids = new Set(preferred.map((model) => model.id));
	const merged = [...preferred];
	for (const model of additional) {
		if (ids.has(model.id)) {continue;}
		ids.add(model.id);
		merged.push(model);
	}
	return merged;
}

function numeric(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function fallbackModels(): CodeBuddyModel[] {
	return [
		{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', family: 'deepseek-v4-flash', version: '1', maxInputTokens: 1_000_000, maxOutputTokens: 50_000, detail: 'CodeBuddy', capabilities: { imageInput: true, toolCalling: true } },
		{ id: 'hy4-preview', name: 'Hy4 Preview', family: 'hy4-preview', version: '1', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, detail: 'CodeBuddy', capabilities: { imageInput: true, toolCalling: true } },
		{ id: 'glm-5.3', name: 'GLM-5.3', family: 'glm-5.3', version: '1', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, detail: 'CodeBuddy', capabilities: { imageInput: true, toolCalling: true } },
	];
}

function rewriteCodeBuddyFingerprint(text: string): string {
	return text.replace(/Main branch \(you will usually use this for PRs\)/gi, 'Main branch (PRs usually go here)');
}

function toolDefinitions(tools: readonly vscode.LanguageModelChatTool[] | undefined): unknown[] | undefined {
	if (!tools?.length) {return undefined;}
	return tools.map((tool) => ({
		type: 'function',
		function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
	}));
}

export class CodeBuddyChatProvider implements vscode.LanguageModelChatProvider<CodeBuddyModel>, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;
	private cachedModels: CodeBuddyModel[] = [];
	private catalogLoadedAt = 0;

	constructor(private readonly secrets: vscode.SecretStorage, private readonly secretKey: string) {}

	async provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		token: vscode.CancellationToken,
	): Promise<CodeBuddyModel[]> {
		if (options.silent && (await this.secrets.get(this.secretKey)) === undefined) {return [];}
		const credential = await readCodeBuddyCredential(this.secrets, this.secretKey, token);
		if (!credential) {return [];}
		if (Date.now() - this.catalogLoadedAt > CATALOG_TTL_MS || this.cachedModels.length === 0) {
			await this.loadModels(credential, token);
		}
		return this.cachedModels;
	}

	async provideLanguageModelChatResponse(
		model: CodeBuddyModel,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const credential = await readCodeBuddyCredential(this.secrets, this.secretKey, token);
		if (!credential) {throw new Error('请先运行“CodeBuddy: 登录 / 管理账号”');}
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			const body: Record<string, unknown> = {
				model: model.id,
				messages: messagesToOpenAi(messages),
				stream: true,
				max_tokens: model.maxOutputTokens,
			};
			const tools = toolDefinitions(options.tools);
			if (tools) {
				body.tools = tools;
				if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {body.tool_choice = 'required';}
			}
			const response = await fetch(`${API}/v2/chat/completions`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${credential.access_token}`,
					Accept: 'text/event-stream',
					'Content-Type': 'application/json',
					'X-Domain': DOMAIN,
					'X-Product-Code': 'codebuddy',
					'X-Agent-Purpose': 'conversation',
					'X-IDE-Name': 'CodeBuddy',
					'X-IDE-Type': 'CodeBuddy',
					'X-IDE-Version': '1.106.1',
					'X-Product': 'CodeBuddy',
					'User-Agent': USER_AGENT,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!response.ok) {
				const detail = await response.text();
				throw new Error(`CodeBuddy HTTP ${response.status}: ${detail.slice(0, 1000)}`);
			}
			if (!response.body) {throw new Error('CodeBuddy 返回了空响应流');}
			await consumeSse(response.body, progress, token);
		} finally {
			cancellation.dispose();
		}
	}

	provideTokenCount(_model: CodeBuddyModel, text: string | vscode.LanguageModelChatRequestMessage): Thenable<number> {
		const value = typeof text === 'string' ? text : textFrom(text.content);
		return Promise.resolve(Math.ceil(value.length / 4));
	}

	async refreshModels(): Promise<void> {
		this.cachedModels = [];
		this.catalogLoadedAt = 0;
		this.changeEmitter.fire();
	}

	dispose(): void {
		this.changeEmitter.dispose();
	}

	private async loadModels(credential: CodeBuddyCredential, token: vscode.CancellationToken): Promise<void> {
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			const headers = {
				Authorization: `Bearer ${credential.access_token}`,
				'X-Domain': DOMAIN,
				'X-Product': 'SaaS',
				'X-Product-Code': 'codebuddy',
				'User-Agent': USER_AGENT,
			};
			const [scoped, config] = await Promise.all([
				fetch(`${API}/console/enterprises/personal/models`, { headers, signal: controller.signal }).catch(() => undefined),
				fetch(`${API}/v3/config`, { headers, signal: controller.signal }).catch(() => undefined),
			]);
			if (scoped?.status === 401 || scoped?.status === 403 || config?.status === 401 || config?.status === 403) {
				throw new Error('CodeBuddy 登录凭据已过期，请重新登录');
			}
			const scopedModels = scoped?.ok ? parseCodeBuddyModels(await scoped.json()) : [];
			const configModels = config?.ok ? parseCodeBuddyModels(await config.json()) : [];
			this.cachedModels = mergeCodeBuddyModels(
				scopedModels.length > 0 ? scopedModels : configModels,
				scopedModels.length > 0 ? configModels : [],
			);
		} catch (error) {
			if (token.isCancellationRequested) {throw error;}
		} finally {
			cancellation.dispose();
			this.catalogLoadedAt = Date.now();
		}
		if (this.cachedModels.length === 0) {this.cachedModels = fallbackModels();}
	}
}

export async function consumeSse(
	body: ReadableStream<Uint8Array>,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	token: vscode.CancellationToken,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	const toolCalls = new Map<number, PendingToolCall>();
	const emitLine = (line: string): void => {
		if (!line.startsWith('data:')) {return;}
		const payload = line.slice(5).trim();
		if (payload === '' || payload === '[DONE]') {return;}
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			throw new Error('CodeBuddy 返回了无法解析的 SSE 数据');
		}
		if (!isRecord(parsed)) {return;}
		if (isRecord(parsed.error)) {
			throw new Error(typeof parsed.error.message === 'string' ? parsed.error.message : 'CodeBuddy 返回了模型错误');
		}
		const choices = parsed.choices;
		if (!Array.isArray(choices)) {
			const message = typeof parsed.message === 'string'
				? parsed.message
				: typeof parsed.msg === 'string' ? parsed.msg : undefined;
			if (parsed.code !== undefined || message !== undefined) {
				throw new Error(message ?? `CodeBuddy 返回业务错误码 ${String(parsed.code)}`);
			}
			return;
		}
		for (const choice of choices) {
			if (!isRecord(choice) || !isRecord(choice.delta)) {continue;}
			const delta = choice.delta;
			if (typeof delta.content === 'string' && delta.content.length > 0) {
				progress.report(new vscode.LanguageModelTextPart(delta.content));
			}
			if (Array.isArray(delta.tool_calls)) {
				for (const value of delta.tool_calls) {
					if (!isRecord(value) || typeof value.index !== 'number') {continue;}
					const current = toolCalls.get(value.index) ?? { id: '', name: '', arguments: '' };
					if (typeof value.id === 'string') {current.id += value.id;}
					if (isRecord(value.function)) {
						if (typeof value.function.name === 'string') {current.name += value.function.name;}
						if (typeof value.function.arguments === 'string') {current.arguments += value.function.arguments;}
					}
					toolCalls.set(value.index, current);
				}
			}
		}
	};
	try {
		while (true) {
			if (token.isCancellationRequested) {
				await reader.cancel();
				throw new Error('请求已取消');
			}
			const { done, value } = await reader.read();
			if (done) {break;}
			buffer += decoder.decode(value, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, '');
				buffer = buffer.slice(newline + 1);
				emitLine(line);
			}
		}
		buffer += decoder.decode();
		if (buffer.trim()) {emitLine(buffer.trim());}
	} finally {
		reader.releaseLock();
	}
	for (const call of toolCalls.values()) {
		let input: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(call.arguments || '{}');
			if (!isRecord(parsed)) {throw new Error('工具参数必须是 JSON 对象');}
			input = parsed;
		} catch {
				throw new Error(`CodeBuddy 返回了无效的工具参数：${call.name}`);
		}
			if (!call.id || !call.name) {throw new Error('CodeBuddy 返回了不完整的工具调用');}
		progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
	}
}