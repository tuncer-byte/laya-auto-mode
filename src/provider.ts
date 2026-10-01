import * as vscode from 'vscode';
import { describeMessages, parseRequest, ParsedRequest } from './request';
import type { CandidateInfo, Decision, EditorContextInfo, Sidecar, Tier } from './sidecar';

type Bias = 'eco' | 'balanced' | 'max';

interface Mode {
	id: string;
	name: string;
	bias: Bias;
	detail: string;
}

const MODES: Mode[] = [
	{ id: 'laya-auto', name: 'Laya Auto', bias: 'balanced', detail: 'Laya picks per request' },
	{ id: 'laya-eco', name: 'Laya Eco', bias: 'eco', detail: 'Laya, leaning to faster models' },
	{ id: 'laya-max', name: 'Laya Max', bias: 'max', detail: 'Laya, leaning to stronger models' },
];

export interface RoutedEvent {
	at: number;
	mode: string;
	prompt: string;
	decision: Decision;
	offline: boolean;
	continuation: boolean;
}

/**
 * A chat model provider whose "models" are routing modes. Each request is classified by the
 * local Laya server and forwarded, tools and all, to the Copilot model it picks.
 */
export class LayaProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changed.event;
	private readonly routed = new vscode.EventEmitter<RoutedEvent>();
	readonly onDidRoute = this.routed.event;

	private readonly byTurn = new Map<string, Decision>();
	private signature = '';
	private readonly subscriptions: vscode.Disposable[] = [];

	constructor(private readonly sidecar: Sidecar, private readonly log: vscode.OutputChannel) {
		this.subscriptions.push(
			vscode.lm.onDidChangeChatModels(async () => {
				// Our own registration also fires this event; only re-announce real changes.
				const next = (await this.targets()).map(m => m.id).sort().join(',');
				if (next !== this.signature) {
					this.signature = next;
					this.changed.fire();
				}
			}),
		);
	}

	async targets(): Promise<vscode.LanguageModelChat[]> {
		const vendors = vscode.workspace.getConfiguration('laya').get<string[]>('vendors', ['copilot']);
		const found = await Promise.all(vendors.map(vendor => vscode.lm.selectChatModels({ vendor })));
		const seen = new Set<string>();
		return found.flat().filter(m => {
			if (m.vendor === 'laya' || seen.has(m.id)) {
				return false;
			}
			seen.add(m.id);
			return true;
		});
	}

	candidates(models: vscode.LanguageModelChat[]): CandidateInfo[] {
		const overrides = vscode.workspace.getConfiguration('laya').get<Record<string, Tier>>('tierOverrides', {});
		return models.map(m => ({
			id: m.id,
			name: m.name,
			family: m.family,
			vendor: m.vendor,
			max_input_tokens: m.maxInputTokens,
			tool_calling: true,
			image_input: true,
			tier: overrides[m.id] ?? overrides[m.family],
		}));
	}

	async provideLanguageModelChatInformation(): Promise<vscode.LanguageModelChatInformation[]> {
		const models = await this.targets();
		this.signature = models.map(m => m.id).sort().join(',');
		const maxInput = Math.max(0, ...models.map(m => m.maxInputTokens)) || 128_000;
		return MODES.map(mode => ({
			id: mode.id,
			name: mode.name,
			family: 'laya',
			version: '0.1.0',
			detail: mode.detail,
			tooltip: `${mode.detail}. An on-device Laya model reads your request and routes it to one of ${models.length} models.`,
			maxInputTokens: maxInput,
			maxOutputTokens: 64_000,
			capabilities: { toolCalling: true, imageInput: true },
		}));
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const mode = MODES.find(m => m.id === model.id) ?? MODES[0];
		const parsed = parseRequest(messages, options.tools?.length ?? 0);
		this.log.appendLine(`[laya] request: ${messages.length} messages, ${options.tools?.length ?? 0} tools\n${describeMessages(messages)}`);
		const models = await this.targets();
		if (!models.length) {
			throw new Error('Laya found no Copilot models to route to. Sign in to GitHub Copilot and try again.');
		}

		// Keep one model for the whole turn so a tool loop never switches models midway.
		const cacheKey = `${mode.id}|${parsed.turnKey}`;
		let decision = parsed.continuation ? this.byTurn.get(cacheKey) : undefined;
		let offline = false;
		if (!decision) {
			({ decision, offline } = await this.decide(parsed, mode.bias, models, token));
			this.remember(cacheKey, decision);
			this.routed.fire({
				at: Date.now(),
				mode: mode.name,
				prompt: parsed.prompt,
				decision,
				offline,
				continuation: parsed.continuation,
			});
		}
		if (!parsed.continuation) {
			this.log.appendLine(`[laya] read request (${parsed.prompt.length} chars): ${JSON.stringify(parsed.prompt.slice(0, 200))}`);
		}
		const target = models.find(m => m.id === decision!.model?.id) ?? models[0];
		this.log.appendLine(
			`[laya] ${parsed.continuation ? '↻' : '→'} ${target.name} (${decision.tier}, effort ${decision.effort.toFixed(2)}) :: ${parsed.prompt.slice(0, 80)}`,
		);

		if (!parsed.continuation && vscode.workspace.getConfiguration('laya').get<boolean>('showDecisionInChat', true)) {
			progress.report(new vscode.LanguageModelTextPart(note(decision, target, offline)));
		}

		const forwarded = messages.map(forward);
		const response = await target.sendRequest(
			forwarded,
			{
				tools: options.tools ? [...options.tools] : undefined,
				toolMode: options.toolMode,
				modelOptions: options.modelOptions,
				justification: 'Laya forwards your chat request to the model it selected for it.',
			},
			token,
		);
		for await (const part of response.stream) {
			progress.report(part as vscode.LanguageModelResponsePart);
		}
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
	): Promise<number> {
		const value =
			typeof text === 'string'
				? text
				: text.content.map(p => (p instanceof vscode.LanguageModelTextPart ? p.value : JSON.stringify(p))).join('');
		return Math.ceil(value.length / 4);
	}

	async decide(
		parsed: Pick<ParsedRequest, 'prompt' | 'context'>,
		bias: Bias,
		models: vscode.LanguageModelChat[],
		token?: vscode.CancellationToken,
	): Promise<{ decision: Decision; offline: boolean }> {
		const candidates = this.candidates(models);
		const preferences = vscode.workspace.getConfiguration('laya').get<Record<string, string[]>>('preferences', {});
		if (await this.sidecar.ensure()) {
			try {
				const decision = await this.sidecar.route(
					{ prompt: parsed.prompt, bias, context: parsed.context, candidates, preferences },
					token,
				);
				if (decision.model) {
					return { decision, offline: false };
				}
			} catch (err) {
				this.log.appendLine(`[laya] routing failed, using fallback: ${err}`);
			}
		}
		return { decision: fallback(parsed.prompt, parsed.context, candidates), offline: true };
	}

	private remember(key: string, decision: Decision) {
		this.byTurn.set(key, decision);
		if (this.byTurn.size > 200) {
			this.byTurn.delete(this.byTurn.keys().next().value!);
		}
	}

	dispose() {
		this.changed.dispose();
		this.routed.dispose();
		this.subscriptions.forEach(d => d.dispose());
	}
}

/**
 * Re-create a message for another model. Copilot hands providers its system prompt with the
 * System role (3), but sending that role onward needs the `languageModelSystem` API proposal,
 * which a published extension cannot enable. The system prompt goes on as a user message.
 */
function forward(m: vscode.LanguageModelChatRequestMessage): vscode.LanguageModelChatMessage {
	const content = m.content as vscode.LanguageModelInputPart[];
	const { User, Assistant } = vscode.LanguageModelChatMessageRole;
	if (m.role === User || m.role === Assistant) {
		return new vscode.LanguageModelChatMessage(m.role, content, m.name);
	}
	const text = content.map(p => (p instanceof vscode.LanguageModelTextPart ? p.value : '')).join('');
	return vscode.LanguageModelChatMessage.User(`<system_instructions>\n${text}\n</system_instructions>`);
}

function note(decision: Decision, target: vscode.LanguageModelChat, offline: boolean): string {
	const signals = decision.signals;
	const source = offline ? 'heuristic, Laya offline' : `${decision.laya.checkpoint} · ${Math.round(decision.laya.latency_ms)} ms`;
	return `*🧭 Laya → **${target.name}** · ${decision.tier} · ${signals.task} · effort ${decision.effort.toFixed(2)} · ${source}*\n\n`;
}

/** Keyword rules used only while the Laya server is unreachable. */
function fallback(prompt: string, context: EditorContextInfo, candidates: CandidateInfo[]): Decision {
	const text = prompt.toLowerCase();
	let effort = Math.min(1.5, prompt.length / 250) + 0.6;
	if (/architect|design|migrat|refactor|concurren|race|deadlock|leak|mimari|tasarla|taşı/.test(text)) {
		effort += 1.2;
	}
	if (/bug|error|fail|fix|hata|düzelt|test/.test(text)) {
		effort += 0.5;
	}
	if (/^(hi|hello|thanks|merhaba|teşekkür)/.test(text)) {
		effort = 0.2;
	}
	if (context.tools) {
		effort += 0.15;
	}
	const tier: Tier = effort < 1.4 ? 'fast' : effort < 2.3 ? 'balanced' : 'reasoning';
	const tierOf = (c: CandidateInfo): Tier =>
		c.tier ??
		(/\b(mini|nano|haiku|flash|lite|fast)\b/i.test(`${c.id} ${c.name}`)
			? 'fast'
			: /opus|\bo3\b|pro\b/i.test(`${c.id} ${c.name}`)
				? 'reasoning'
				: 'balanced');
	const usable = candidates.filter(c => !/^auto$/i.test(c.id));
	const pick = usable.find(c => tierOf(c) === tier) ?? usable.find(c => tierOf(c) === 'balanced') ?? usable[0];
	return {
		tier,
		wanted_tier: tier,
		model: pick ?? null,
		effort,
		effort_parts: [{ label: 'keyword heuristic', amount: effort }],
		thresholds: { fast_below: 1.4, reasoning_from: 2.3 },
		signals: { task: 'unknown', task_confidence: 0, complexity: 0, multi_file: 0, deep_reasoning: 0 },
		task_probabilities: {},
		notes: ['Laya server unreachable; keyword fallback'],
		tiers: {},
		laya: { checkpoint: 'offline', checkpoint_reason: 'server unreachable', latency_ms: 0 },
		total_ms: 0,
	};
}
