import * as vscode from 'vscode';
import type { RoutedEvent } from './provider';

/** Webview that explains every routing decision: signals, effort breakdown, chosen model. */
export class DecisionsPanel {
	private static current: DecisionsPanel | undefined;
	private readonly panel: vscode.WebviewPanel;

	static show(history: RoutedEvent[]) {
		if (DecisionsPanel.current) {
			DecisionsPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
		} else {
			DecisionsPanel.current = new DecisionsPanel();
		}
		DecisionsPanel.current.update(history);
	}

	static refresh(history: RoutedEvent[]) {
		DecisionsPanel.current?.update(history);
	}

	private constructor() {
		this.panel = vscode.window.createWebviewPanel(
			'layaDecisions',
			'Laya Routing',
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		this.panel.iconPath = new vscode.ThemeIcon('compass');
		this.panel.onDidDispose(() => (DecisionsPanel.current = undefined));
		this.panel.webview.html = html(nonce());
	}

	private update(history: RoutedEvent[]) {
		void this.panel.webview.postMessage({ type: 'history', items: history });
	}
}

function nonce(): string {
	return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

function html(n: string): string {
	return /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${n}">
:root {
	--fast: var(--vscode-charts-green, #3fb950);
	--balanced: var(--vscode-charts-blue, #4c8dff);
	--reasoning: var(--vscode-charts-purple, #a371f7);
	--muted: var(--vscode-descriptionForeground);
	--line: var(--vscode-widget-border, rgba(128,128,128,.25));
	--card: var(--vscode-editorWidget-background, rgba(128,128,128,.06));
}
* { box-sizing: border-box; }
body { margin: 0; padding: 20px 20px 40px; font-family: var(--vscode-font-family); font-size: 13px;
	color: var(--vscode-foreground); background: var(--vscode-editor-background); }
h1 { font-size: 15px; font-weight: 600; margin: 0 0 2px; display: flex; gap: 8px; align-items: center; }
.sub { color: var(--muted); margin: 0 0 18px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-bottom: 18px; }
.stat { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.stat b { display: block; font-size: 18px; font-variant-numeric: tabular-nums; }
.stat span { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
.mix { display: flex; height: 6px; border-radius: 3px; overflow: hidden; margin-top: 8px; background: var(--line); }
.mix i { display: block; height: 100%; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
.card.latest { border-color: var(--vscode-focusBorder); }
.head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.model { font-weight: 600; font-size: 14px; }
.pill { font-size: 11px; padding: 1px 8px; border-radius: 10px; color: var(--vscode-editor-background); font-weight: 600; }
.pill.fast { background: var(--fast); } .pill.balanced { background: var(--balanced); } .pill.reasoning { background: var(--reasoning); }
.tag { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 10px; padding: 0 7px; }
.time { margin-left: auto; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.prompt { margin: 8px 0 12px; color: var(--vscode-foreground); opacity: .9; white-space: pre-wrap; word-break: break-word;
	border-left: 2px solid var(--line); padding-left: 10px; max-height: 4.5em; overflow: hidden; }
.gauge { position: relative; height: 22px; margin: 4px 0 2px; }
.zone { position: absolute; top: 8px; height: 6px; }
.zone.fast { background: color-mix(in srgb, var(--fast) 45%, transparent); border-radius: 3px 0 0 3px; }
.zone.balanced { background: color-mix(in srgb, var(--balanced) 45%, transparent); }
.zone.reasoning { background: color-mix(in srgb, var(--reasoning) 45%, transparent); border-radius: 0 3px 3px 0; }
.marker { position: absolute; top: 2px; width: 3px; height: 18px; border-radius: 2px; background: var(--vscode-foreground); transform: translateX(-1px); }
.scale { display: flex; justify-content: space-between; color: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 12px; }
@media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
.label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px; }
.row { display: grid; grid-template-columns: 1fr 44px; gap: 8px; align-items: center; margin: 3px 0; font-size: 12px; }
.row .name { display: flex; gap: 6px; align-items: center; min-width: 0; }
.row .name span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar { flex: 0 0 70px; height: 5px; border-radius: 3px; background: var(--line); overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--vscode-foreground); opacity: .7; }
.bar.neg i { background: var(--fast); opacity: 1; margin-left: auto; }
.num { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
.foot { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; display: flex; gap: 14px; flex-wrap: wrap; }
.empty { color: var(--muted); padding: 40px 0; text-align: center; line-height: 1.7; }
</style></head>
<body>
<h1>🧭 Laya routing</h1>
<p class="sub">An on-device Laya model reads each request and picks the Copilot model. Nothing leaves your machine for the decision.</p>
<div id="root"><div class="empty">No decisions yet.<br>Pick <b>Laya Auto</b> in the Copilot Chat model picker and send a message.</div></div>
<script nonce="${n}">
const root = document.getElementById('root');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pct = v => Math.round(v * 100) + '%';
const MAX = 4;
const pos = v => Math.max(0, Math.min(100, v / MAX * 100));

function gauge(d) {
	const a = pos(d.thresholds.fast_below), b = pos(d.thresholds.reasoning_from);
	return '<div class="gauge">'
		+ '<div class="zone fast" style="left:0;width:' + a + '%"></div>'
		+ '<div class="zone balanced" style="left:' + a + '%;width:' + (b - a) + '%"></div>'
		+ '<div class="zone reasoning" style="left:' + b + '%;width:' + (100 - b) + '%"></div>'
		+ '<div class="marker" style="left:' + pos(d.effort) + '%" title="effort ' + d.effort.toFixed(2) + '"></div></div>'
		+ '<div class="scale"><span>0</span><span>fast &lt; ' + d.thresholds.fast_below + '</span><span>reasoning ≥ ' + d.thresholds.reasoning_from + '</span><span>' + MAX + '</span></div>';
}

function parts(d) {
	const peak = Math.max(0.5, ...d.effort_parts.map(p => Math.abs(p.amount)));
	return d.effort_parts.map(p => '<div class="row"><div class="name"><div class="bar ' + (p.amount < 0 ? 'neg' : '') + '"><i style="width:'
		+ Math.abs(p.amount) / peak * 100 + '%"></i></div><span>' + esc(p.label) + '</span></div><div class="num">'
		+ (p.amount > 0 ? '+' : '') + p.amount.toFixed(2) + '</div></div>').join('');
}

function tasks(d) {
	const top = Object.entries(d.task_probabilities || {}).sort((x, y) => y[1] - x[1]).slice(0, 4);
	const s = d.signals;
	const rows = top.map(([k, v]) => '<div class="row"><div class="name"><div class="bar"><i style="width:' + v * 100 + '%"></i></div><span>' + esc(k) + '</span></div><div class="num">' + pct(v) + '</div></div>');
	rows.push('<div class="row"><div class="name"><div class="bar"><i style="width:' + s.multi_file * 100 + '%"></i></div><span>spans many files</span></div><div class="num">' + pct(s.multi_file) + '</div></div>');
	rows.push('<div class="row"><div class="name"><div class="bar"><i style="width:' + s.deep_reasoning * 100 + '%"></i></div><span>deep reasoning</span></div><div class="num">' + pct(s.deep_reasoning) + '</div></div>');
	return rows.join('');
}

function card(e, i) {
	const d = e.decision;
	const when = new Date(e.at).toLocaleTimeString();
	const notes = (d.notes || []).map(n => '<span>⚠ ' + esc(n) + '</span>').join('');
	return '<div class="card ' + (i === 0 ? 'latest' : '') + '">'
		+ '<div class="head"><span class="model">' + esc(d.model ? d.model.name : 'no model') + '</span>'
		+ '<span class="pill ' + d.tier + '">' + d.tier + '</span><span class="tag">' + esc(e.mode) + '</span>'
		+ (e.offline ? '<span class="tag">offline fallback</span>' : '')
		+ '<span class="time">' + when + '</span></div>'
		+ '<div class="prompt">' + esc(e.prompt || '(empty)') + '</div>'
		+ gauge(d)
		+ '<div class="grid"><div><div class="label">Effort ' + d.effort.toFixed(2) + ' — why</div>' + parts(d) + '</div>'
		+ '<div><div class="label">Laya signals</div>' + tasks(d) + '</div></div>'
		+ '<div class="foot"><span>checkpoint: <b>' + esc(d.laya.checkpoint) + '</b> — ' + esc(d.laya.checkpoint_reason) + '</span>'
		+ '<span>Laya ' + Math.round(d.laya.latency_ms) + ' ms · 0 output tokens</span>' + notes + '</div></div>';
}

function stats(items) {
	const n = items.length;
	const count = t => items.filter(e => e.decision.tier === t).length;
	const live = items.filter(e => !e.offline);
	const avg = live.length ? live.reduce((s, e) => s + e.decision.laya.latency_ms, 0) / live.length : 0;
	const mix = ['fast', 'balanced', 'reasoning'].map(t => '<i style="width:' + count(t) / n * 100 + '%;background:var(--' + t + ')"></i>').join('');
	return '<div class="stats">'
		+ '<div class="stat"><b>' + n + '</b><span>decisions</span><div class="mix">' + mix + '</div></div>'
		+ '<div class="stat"><b>' + count('fast') + '</b><span>fast</span></div>'
		+ '<div class="stat"><b>' + count('balanced') + '</b><span>balanced</span></div>'
		+ '<div class="stat"><b>' + count('reasoning') + '</b><span>reasoning</span></div>'
		+ '<div class="stat"><b>' + Math.round(avg) + ' ms</b><span>avg Laya latency</span></div></div>';
}

window.addEventListener('message', ev => {
	if (ev.data.type !== 'history' || !ev.data.items.length) return;
	const items = ev.data.items.slice().reverse();
	root.innerHTML = stats(items) + items.map(card).join('');
});
</script></body></html>`;
}
