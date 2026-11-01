/**
 * ONE PROBLEM'S LANGUAGE SERVER (docs/practice-workspaces-plan.md, step 4):
 * the learner's files and the VISIBLE tests in /work/lsp (never the hidden
 * tests — the diagnostics would leak them), the language's server started
 * there, every save fed in, and the latest errors and warnings per file
 * kept for the pane to fetch. Restarts once after a crash.
 */

import type { CodeFile, DiagnosticsSnapshot, DiagnosticsStatus } from "../../../core/contracts/workspaces.ts";
import { LANGUAGES, LSP_ROOT, type CodeLanguage } from "./languages.ts";
import { LspClient, type CodeDiagnostic } from "./lsp-client.ts";
import type { CodeRunner, ProblemKey, SpawnedProcess } from "./runner.ts";

export type { DiagnosticsSnapshot, DiagnosticsStatus } from "../../../core/contracts/workspaces.ts";

export interface DiagnosticsSession {
	snapshot(): DiagnosticsSnapshot;
	/** Feed the learner's current files (the saved set). */
	update(files: readonly CodeFile[]): void;
	stop(): Promise<void>;
}

const MAX_RESTARTS = 1;

export function createDiagnosticsSession(opts: {
	runner: CodeRunner;
	key: ProblemKey;
	language: CodeLanguage;
	files: readonly CodeFile[];
	visibleTests: readonly CodeFile[];
	/** Something the pane shows changed (status or diagnostics). */
	onChange: () => void;
}): DiagnosticsSession {
	const spec = LANGUAGES[opts.language];
	const lsp = spec.lsp;
	let status: DiagnosticsStatus = "starting";
	let diagnostics: Record<string, CodeDiagnostic[]> = {};
	/** The files the server should hold: learner files + visible tests. */
	let current = new Map<string, string>([...opts.files, ...opts.visibleTests].map((f) => [f.path, f.content]));
	const known = () => new Set(current.keys());
	let client: LspClient | null = null;
	let process: SpawnedProcess | null = null;
	let stopped = false;
	let restarts = 0;
	/** Paths changed while the server was starting (synced once ready). */
	const sent = new Map<string, string>();

	const setStatus = (next: DiagnosticsStatus) => {
		if (status === next) return;
		status = next;
		opts.onChange();
	};

	async function start(): Promise<void> {
		setStatus("starting");
		diagnostics = {};
		sent.clear();
		const files = [...lsp.config, ...[...current].map(([path, content]) => ({ path, content }))];
		await opts.runner.writeFiles({ key: opts.key, image: spec.image, dir: LSP_ROOT, files, fresh: true });
		if (lsp.setup) {
			const setup = await opts.runner.spawn({ key: opts.key, image: spec.image, command: lsp.setup, workingDir: LSP_ROOT });
			// stdin stays open: a half-close can drop the exec before its output (Windows engines); the script exits on its own.
			setup.stdout.resume();
			await setup.exited;
		}
		if (stopped) return;
		const proc = await opts.runner.spawn({ key: opts.key, image: spec.image, command: lsp.command, workingDir: LSP_ROOT });
		process = proc;
		const c = new LspClient(proc.stdin, proc.stdout, {
			root: LSP_ROOT,
			...(lsp.initializationOptions !== undefined ? { initializationOptions: lsp.initializationOptions } : {}),
			...(lsp.settings ? { settings: lsp.settings } : {}),
			...(lsp.initializeTimeoutMs ? { initializeTimeoutMs: lsp.initializeTimeoutMs } : {}),
			onDiagnostics: (path, list) => {
				if (!known().has(path)) return;
				diagnostics = { ...diagnostics, [path]: list };
				opts.onChange();
			},
		});
		client = c;
		void proc.exited.then(() => {
			if (stopped || process !== proc) return;
			client = null;
			process = null;
			if (restarts < MAX_RESTARTS) {
				restarts++;
				void start().catch(() => setStatus("crashed"));
			} else setStatus("crashed");
		});
		await c.initialize();
		if (stopped || client !== c) return;
		syncChanged();
		setStatus("ready");
	}

	function syncChanged(): void {
		if (!client) return;
		for (const [path, content] of current) {
			if (sent.get(path) === content) continue;
			sent.set(path, content);
			client.sync(path, lsp.languageId(path), content);
		}
	}

	void start().catch(() => {
		if (!stopped) setStatus("crashed");
	});

	return {
		snapshot: () => ({ status, name: lsp.name, files: diagnostics }),

		update(files) {
			if (stopped) return;
			const changed: CodeFile[] = [];
			const next = new Map(current);
			for (const f of files) {
				if (!next.has(f.path) || next.get(f.path) === f.content) continue;
				next.set(f.path, f.content);
				changed.push(f);
			}
			if (changed.length === 0) return;
			current = next;
			// The files on disk too: some servers check what's on disk
			// (rust-analyzer's cargo check). Then the editor-side sync.
			void opts.runner
				.writeFiles({ key: opts.key, image: spec.image, dir: LSP_ROOT, files: changed })
				.catch(() => {})
				.then(() => {
					if (status === "ready") syncChanged();
				});
		},

		async stop() {
			stopped = true;
			const c = client;
			const p = process;
			client = null;
			process = null;
			await c?.shutdown();
			p?.kill();
		},
	};
}

/** A snapshot for problems with no session (Docker down, not started). */
export function unavailableSnapshot(language: CodeLanguage): DiagnosticsSnapshot {
	return { status: "unavailable", name: LANGUAGES[language].lsp.name, files: {} };
}
