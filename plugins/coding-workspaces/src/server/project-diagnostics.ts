/**
 * PROJECT DIAGNOSTICS: the project image's language server, run in the project's
 * container with root /work, fed the project's source files on demand. A check
 * syncs every source file whose text changed since the last check (bounded), then
 * waits for the server's diagnostics to settle. Nothing is written into the
 * learner's folder (no injected config). The server stops with the container.
 */

import fs from "node:fs";
import path from "node:path";
import type { CodeDiagnostic, ProjectProblems } from "../shared/protocol.ts";
import type { SpawnedProcess } from "./docker-runner.ts";
import { languageSpec, type CodeImage, type LspSpec } from "./languages.ts";
import { LspClient } from "./lsp-client.ts";
import { PROJECT_HOME } from "./project-container.ts";
import { walkFiles } from "./project-files.ts";

const MAX_FILES = 200;
const MAX_FILE_BYTES = 256 * 1024;
const QUIET_MS = 1500;
const FIRST_WAIT_MS = 60_000;
const WAIT_MS = 20_000;

/** Which server serves a project image, and the language id of each source extension. */
const PROJECT_LANGUAGES: Record<CodeImage, { spec: string; extensions: Record<string, string> }> = {
	node: { spec: "typescript", extensions: { ".ts": "typescript", ".tsx": "typescriptreact", ".mts": "typescript", ".cts": "typescript", ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript" } },
	python: { spec: "python", extensions: { ".py": "python" } },
	dotnet: { spec: "csharp", extensions: { ".cs": "csharp" } },
	java: { spec: "java", extensions: { ".java": "java" } },
	go: { spec: "go", extensions: { ".go": "go" } },
	rust: { spec: "rust", extensions: { ".rs": "rust" } },
	cpp: { spec: "cpp", extensions: { ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp", ".h": "cpp", ".c": "c" } },
};

/** The server command for a project (state under HOME, never in /work). */
export function projectLsp(image: CodeImage): LspSpec | null {
	const spec = languageSpec(PROJECT_LANGUAGES[image].spec);
	if (!spec) return null;
	const lsp = spec.lsp;
	const home = (s: string) => s.replaceAll("/work/.jdtls", `${PROJECT_HOME}/.jdtls`);
	return { ...lsp, command: home(lsp.command), ...(lsp.setup && image === "java" ? { setup: home(lsp.setup) } : {}), config: [] };
}

/** Project source files the server should see, with their language ids. */
export function sourceFiles(root: string, image: CodeImage): Array<{ path: string; languageId: string }> {
	const extensions = PROJECT_LANGUAGES[image].extensions;
	const out: Array<{ path: string; languageId: string }> = [];
	for (const file of walkFiles(root).files) {
		const languageId = extensions[path.extname(file).toLowerCase()];
		if (languageId) out.push({ path: file, languageId });
		if (out.length >= MAX_FILES) break;
	}
	return out;
}

export interface ProjectDiagnosticsDeps {
	spawn(command: string): Promise<SpawnedProcess>;
	image: CodeImage;
	hostPath: string;
}

export function createProjectDiagnostics(deps: ProjectDiagnosticsDeps) {
	const lsp = projectLsp(deps.image);
	let client: LspClient | null = null;
	let process: SpawnedProcess | null = null;
	let starting: Promise<LspClient> | null = null;
	let crashed = false;
	let lastPublish = 0;
	const sent = new Map<string, string>();
	const diagnostics = new Map<string, CodeDiagnostic[]>();

	async function start(): Promise<LspClient> {
		if (!lsp) throw new Error("no language server for this project");
		if (lsp.setup) {
			const setup = await deps.spawn(lsp.setup);
			setup.stdout.resume();
			await setup.exited;
		}
		const proc = await deps.spawn(lsp.command);
		const c = new LspClient(proc.stdin, proc.stdout, {
			root: "/work",
			...(lsp.initializationOptions !== undefined ? { initializationOptions: lsp.initializationOptions } : {}),
			...(lsp.settings ? { settings: lsp.settings } : {}),
			...(lsp.initializeTimeoutMs ? { initializeTimeoutMs: lsp.initializeTimeoutMs } : {}),
			onDiagnostics: (file, list) => { lastPublish = Date.now(); diagnostics.set(file, list); },
		});
		void proc.exited.then(() => {
			if (process !== proc) return;
			client = null;
			process = null;
			sent.clear();
			crashed = true;
		});
		process = proc;
		await c.initialize();
		client = c;
		return c;
	}

	return {
		available: lsp !== null,
		name: lsp?.name ?? "",
		/** Sync changed sources, wait for diagnostics to settle, and return the problems. */
		async check(): Promise<ProjectProblems> {
			if (!lsp) return { status: "unavailable", name: "", files: [], checked: 0 };
			const first = !client;
			let c = client;
			try {
				if (!c) {
					starting ??= start().finally(() => { starting = null; });
					c = await starting;
				}
			} catch (error) {
				return { status: "crashed", name: lsp.name, files: [], checked: 0, message: error instanceof Error ? error.message : String(error) };
			}
			const files = sourceFiles(deps.hostPath, deps.image);
			const present = new Set(files.map(f => f.path));
			for (const file of [...diagnostics.keys()]) if (!present.has(file)) diagnostics.delete(file);
			const syncStarted = Date.now();
			let changed = 0;
			for (const file of files) {
				let text: string;
				try {
					const full = path.join(deps.hostPath, ...file.path.split("/"));
					if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
					text = fs.readFileSync(full, "utf8");
				} catch { continue; }
				if (sent.get(file.path) === text) continue;
				sent.set(file.path, text);
				c.sync(file.path, file.languageId, text);
				changed++;
			}
			// Settle: wait until the server has been quiet for a moment after our changes.
			const deadline = syncStarted + (first ? FIRST_WAIT_MS : WAIT_MS);
			if (changed > 0) {
				while (Date.now() < deadline) {
					await new Promise(r => setTimeout(r, 250));
					const quietSince = Math.max(lastPublish, syncStarted);
					if (lastPublish >= syncStarted && Date.now() - quietSince >= QUIET_MS) break;
				}
			}
			const out = [...diagnostics.entries()]
				.filter(([file, list]) => present.has(file) && list.length > 0)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([file, list]) => ({ path: file, diagnostics: list }));
			return { status: crashed && !client ? "crashed" : "ready", name: lsp.name, files: out, checked: files.length };
		},
		async stop(): Promise<void> {
			const c = client;
			const p = process;
			client = null;
			process = null;
			sent.clear();
			diagnostics.clear();
			await c?.shutdown();
			p?.kill();
		},
	};
}

export type ProjectDiagnostics = ReturnType<typeof createProjectDiagnostics>;

/** The problems as text for the tutor (1-based lines). */
export function problemsText(p: ProjectProblems): string {
	if (p.status === "unavailable") return "No language server is available for this project's language.";
	if (p.status === "crashed" && !p.files.length) return `The ${p.name} language server failed${p.message ? `: ${p.message}` : ""}.`;
	const count = p.files.reduce((n, f) => n + f.diagnostics.length, 0);
	if (!count) return `${p.name} language server: no errors or warnings in ${p.checked} source file${p.checked === 1 ? "" : "s"}.`;
	const lines = p.files.flatMap(f => f.diagnostics.slice(0, 30).map(d => `${f.path}:${d.line + 1}:${d.column + 1} ${d.severity}: ${d.message}${d.source ? ` (${d.source})` : ""}`));
	return `${p.name} language server: ${count} problem${count === 1 ? "" : "s"}\n${lines.join("\n")}`;
}
