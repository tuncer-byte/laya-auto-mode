import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type Tier = 'fast' | 'balanced' | 'reasoning';

export interface CandidateInfo {
	id: string;
	name: string;
	family: string;
	vendor: string;
	max_input_tokens: number;
	tool_calling: boolean;
	image_input: boolean;
	tier?: Tier;
}

export interface EditorContextInfo {
	attachments: number;
	tools: number;
	turns: number;
	estimated_tokens: number;
	has_images: boolean;
	language_id?: string;
	history: string[];
}

export interface Decision {
	tier: Tier;
	wanted_tier: Tier;
	model: CandidateInfo | null;
	effort: number;
	effort_parts: { label: string; amount: number }[];
	thresholds: { fast_below: number; reasoning_from: number };
	signals: {
		task: string;
		task_confidence: number;
		complexity: number;
		multi_file: number;
		deep_reasoning: number;
	};
	task_probabilities: Record<string, number>;
	notes: string[];
	tiers: Record<string, string[]>;
	laya: { checkpoint: string; checkpoint_reason: string; latency_ms: number };
	total_ms: number;
}

export interface RouteRequest {
	prompt: string;
	bias: 'eco' | 'balanced' | 'max';
	context: EditorContextInfo;
	candidates: CandidateInfo[];
	preferences?: Record<string, string[]>;
}

/** Talks to the local `laya-copilot` server, starting it on demand. */
export class Sidecar implements vscode.Disposable {
	private child: cp.ChildProcess | undefined;
	private starting: Promise<boolean> | undefined;

	constructor(private readonly log: vscode.OutputChannel) {}

	private get url(): string {
		return vscode.workspace.getConfiguration('laya').get<string>('serverUrl', 'http://127.0.0.1:8765').replace(/\/$/, '');
	}

	async healthy(): Promise<boolean> {
		try {
			const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(800) });
			return res.ok;
		} catch {
			return false;
		}
	}

	/** Resolves true once the server answers, starting it if allowed. */
	ensure(): Promise<boolean> {
		if (!this.starting) {
			this.starting = this.start().finally(() => (this.starting = undefined));
		}
		return this.starting;
	}

	private async start(): Promise<boolean> {
		if (await this.healthy()) {
			return true;
		}
		if (!vscode.workspace.getConfiguration('laya').get<boolean>('autoStart', true) || this.child) {
			return false;
		}
		const python = this.python();
		const port = new URL(this.url).port || '8765';
		this.log.appendLine(`[laya] starting ${python} -m laya_mlx.copilot --port ${port}`);
		const child = cp.spawn(python, ['-m', 'laya_mlx.copilot', '--port', port], {
			env: { ...process.env, PYTHONUNBUFFERED: '1' },
		});
		this.child = child;
		child.stdout?.on('data', d => this.log.append(String(d)));
		child.stderr?.on('data', d => this.log.append(String(d)));
		child.on('exit', code => {
			this.log.appendLine(`[laya] server exited (${code})`);
			if (this.child === child) {
				this.child = undefined;
			}
		});
		// Loading two checkpoints and compiling kernels takes a few seconds.
		for (let i = 0; i < 120 && this.child === child; i++) {
			await new Promise(r => setTimeout(r, 500));
			if (await this.healthy()) {
				return true;
			}
		}
		return false;
	}

	private python(): string {
		const configured = vscode.workspace.getConfiguration('laya').get<string>('pythonPath', '');
		if (configured) {
			return configured;
		}
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			for (const dir of ['.venv', 'venv']) {
				const candidate = path.join(folder.uri.fsPath, dir, 'bin', 'python');
				if (fs.existsSync(candidate)) {
					return candidate;
				}
			}
		}
		return 'python3';
	}

	async route(body: RouteRequest, token?: vscode.CancellationToken): Promise<Decision> {
		const controller = new AbortController();
		const sub = token?.onCancellationRequested(() => controller.abort());
		const timer = setTimeout(() => controller.abort(), 5000);
		try {
			const res = await fetch(`${this.url}/route`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!res.ok) {
				throw new Error(`Laya server returned ${res.status}: ${await res.text()}`);
			}
			return (await res.json()) as Decision;
		} finally {
			clearTimeout(timer);
			sub?.dispose();
		}
	}

	async restart(): Promise<boolean> {
		this.stop();
		await new Promise(r => setTimeout(r, 300));
		return this.ensure();
	}

	stop(): void {
		this.child?.kill();
		this.child = undefined;
	}

	dispose(): void {
		this.stop();
	}
}
