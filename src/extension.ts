import * as vscode from 'vscode';
import { DecisionsPanel } from './panel';
import { LayaProvider, RoutedEvent } from './provider';
import { Sidecar } from './sidecar';

const HISTORY_LIMIT = 50;

export function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('Laya Router');
	const sidecar = new Sidecar(log);
	const provider = new LayaProvider(sidecar, log);
	const history: RoutedEvent[] = [];

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	status.command = 'laya.showDecisions';
	status.text = '$(compass) Laya';
	status.tooltip = 'Laya Router: starting the local routing server…';
	status.show();

	const setReady = (ok: boolean) => {
		if (!history.length) {
			status.text = ok ? '$(compass) Laya' : '$(compass) Laya (offline)';
		}
		status.tooltip = ok
			? 'Laya Router is ready. Choose "Laya Auto" in the Copilot Chat model picker.'
			: 'Laya server is not reachable; a keyword fallback is routing. See Output → Laya Router.';
	};

	context.subscriptions.push(
		log,
		sidecar,
		provider,
		status,
		vscode.lm.registerLanguageModelChatProvider('laya', provider),
		provider.onDidRoute(event => {
			history.push(event);
			history.splice(0, Math.max(0, history.length - HISTORY_LIMIT));
			const d = event.decision;
			status.text = `$(compass) ${d.model?.name ?? 'Laya'} · ${d.tier}`;
			status.tooltip = new vscode.MarkdownString(
				`**Laya → ${d.model?.name}** (${d.tier})\n\n` +
					`effort **${d.effort.toFixed(2)}** · task *${d.signals.task}* · ` +
					`${d.laya.checkpoint} checkpoint, ${Math.round(d.laya.latency_ms)} ms\n\n` +
					d.effort_parts.map(p => `- ${p.label}: ${p.amount > 0 ? '+' : ''}${p.amount.toFixed(2)}`).join('\n') +
					'\n\n_Click for the routing panel._',
			);
			DecisionsPanel.refresh(history);
		}),
		vscode.commands.registerCommand('laya.showDecisions', () => DecisionsPanel.show(history)),
		vscode.commands.registerCommand('laya.dryRun', async () => {
			const prompt = await vscode.window.showInputBox({
				title: 'Laya: route a prompt without sending it',
				placeHolder: 'e.g. find the race condition in the token refresh logic',
			});
			if (!prompt) {
				return;
			}
			const models = await provider.targets();
			const context = { attachments: 0, tools: 0, turns: 1, estimated_tokens: 0, has_images: false, history: [] };
			const { decision, offline } = await provider.decide({ prompt, context }, 'balanced', models);
			history.push({ at: Date.now(), mode: 'Dry run', prompt, decision, offline, continuation: false });
			DecisionsPanel.show(history);
		}),
		vscode.commands.registerCommand('laya.listModels', async () => {
			const models = await provider.targets();
			const context = { attachments: 0, tools: 0, turns: 0, estimated_tokens: 0, has_images: false, history: [] };
			const { decision } = await provider.decide({ prompt: 'hello', context }, 'balanced', models);
			const items: vscode.QuickPickItem[] = [];
			for (const tier of ['fast', 'balanced', 'reasoning']) {
				items.push({ label: tier, kind: vscode.QuickPickItemKind.Separator });
				for (const id of decision.tiers[tier] ?? []) {
					const m = models.find(x => x.id === id);
					items.push({ label: m?.name ?? id, description: id, detail: m ? `${m.vendor} · ${m.maxInputTokens.toLocaleString()} input tokens` : undefined });
				}
			}
			await vscode.window.showQuickPick(items, {
				title: 'Models Laya can route to (first in each tier wins; change with laya.preferences / laya.tierOverrides)',
			});
		}),
		vscode.commands.registerCommand('laya.restartServer', async () => {
			status.text = '$(sync~spin) Laya';
			setReady(await sidecar.restart());
		}),
	);

	void sidecar.ensure().then(setReady);
}

export function deactivate() {}
