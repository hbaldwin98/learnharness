/**
 * ONE ITEM'S LANGUAGE SERVER (ported from the fork's practice workspaces): the
 * learner's code (never the teacher's tests — diagnostics would leak them) in
 * LSP_ROOT, the language's server started there, every change fed in, and the
 * latest errors and warnings kept. Restarts once after a crash.
 */

import type { DiagnosticsSnapshot, DiagnosticsStatus, CodeDiagnostic } from "../shared/protocol.ts";
import { LSP_ROOT, type LanguageSpec } from "./languages.ts";
import { LspClient } from "./lsp-client.ts";
import type { DockerRunner, ItemKey, SpawnedProcess } from "./docker-runner.ts";

export interface DiagnosticsSession {
	snapshot(): DiagnosticsSnapshot;
	update(code: string): void;
	stop(): Promise<void>;
}

const MAX_RESTARTS = 1;

export function createDiagnosticsSession(opts: {
	runner: Pick<DockerRunner, "writeFiles" | "spawn">;
	key: ItemKey;
	spec: LanguageSpec;
	code: string;
	onChange: () => void;
}): DiagnosticsSession {
	const { spec } = opts;
	const lsp = spec.lsp;
	let status: DiagnosticsStatus = "starting";
	let diagnostics: CodeDiagnostic[] = [];
	let code = opts.code;
	/** The file name is fixed at start (a Java class rename keeps the old file until restart). */
	const file = spec.fileName(code);
	let client: LspClient | null = null;
	let process: SpawnedProcess | null = null;
	let stopped = false;
	let restarts = 0;
	let sent: string | null = null;

	const setStatus = (next: DiagnosticsStatus) => {
		if (status === next) return;
		status = next;
		opts.onChange();
	};

	async function start(): Promise<void> {
		setStatus("starting");
		diagnostics = [];
		sent = null;
		await opts.runner.writeFiles({ key: opts.key, image: spec.image, dir: LSP_ROOT, files: [...lsp.config, { path: file, content: code }], fresh: true });
		if (lsp.setup) {
			const setup = await opts.runner.spawn({ key: opts.key, image: spec.image, command: lsp.setup, workingDir: LSP_ROOT });
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
				if (path !== file) return;
				diagnostics = list;
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
		sync();
		setStatus("ready");
	}

	function sync(): void {
		if (!client || sent === code) return;
		sent = code;
		client.sync(file, lsp.languageId, code);
	}

	void start().catch(() => { if (!stopped) setStatus("crashed"); });

	return {
		snapshot: () => ({ status, name: lsp.name, diagnostics }),
		update(next) {
			if (stopped || next === code) return;
			code = next;
			// Also on disk: some servers check what's on disk (rust-analyzer's cargo check).
			void opts.runner.writeFiles({ key: opts.key, image: spec.image, dir: LSP_ROOT, files: [{ path: file, content: code }] })
				.catch(() => {})
				.then(() => { if (status === "ready") sync(); });
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

export function unavailableSnapshot(name = ""): DiagnosticsSnapshot {
	return { status: "unavailable", name, diagnostics: [] };
}
