/**
 * THE LANGUAGE-SERVER CLIENT (docs/practice-workspaces-plan.md, step 4;
 * owner ruling: the server is the LSP client — the browser never speaks
 * LSP). JSON-RPC over a language server's stdio, advertising only what
 * diagnostics need: open/change/save notifications in, publishDiagnostics
 * out. Errors and warnings only (information and hints are dropped).
 *
 * Pure over two streams — the Docker exec that hosts the server is the
 * runner's business (CodeRunner.spawn).
 */

import type { Readable, Writable } from "node:stream";

import type { CodeDiagnostic } from "../../../core/contracts/workspaces.ts";
export type { CodeDiagnostic } from "../../../core/contracts/workspaces.ts";

// ─── framing ─────────────────────────────────────────────────────────────────

/** Split a byte stream into JSON-RPC messages (Content-Length framing).
 *  Feed chunks as they arrive; complete messages come out in order. */
export class LspFramer {
	private buffer = Buffer.alloc(0);

	push(chunk: Buffer): unknown[] {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		const out: unknown[] = [];
		for (;;) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) break;
			const header = this.buffer.subarray(0, headerEnd).toString("ascii");
			const length = /Content-Length:\s*(\d+)/i.exec(header);
			if (!length) {
				// Not a header (stray output): drop through the separator.
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}
			const start = headerEnd + 4;
			const end = start + Number(length[1]);
			if (this.buffer.length < end) break;
			const body = this.buffer.subarray(start, end).toString("utf8");
			this.buffer = this.buffer.subarray(end);
			try {
				out.push(JSON.parse(body));
			} catch {
				// a malformed message is skipped
			}
		}
		return out;
	}
}

export function frame(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

// ─── normalization ───────────────────────────────────────────────────────────

interface LspDiagnostic {
	range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } };
	severity?: number;
	message?: string;
	source?: string;
}

/** publishDiagnostics → errors and warnings for one file (an absent
 *  severity counts as an error, per the protocol's "client decides"). */
export function normalizeDiagnostics(path: string, diagnostics: readonly LspDiagnostic[]): CodeDiagnostic[] {
	const out: CodeDiagnostic[] = [];
	for (const d of diagnostics) {
		const severity = d.severity ?? 1;
		if (severity !== 1 && severity !== 2) continue;
		const start = d.range?.start ?? {};
		const end = d.range?.end ?? start;
		out.push({
			path,
			line: start.line ?? 0,
			column: start.character ?? 0,
			endLine: end.line ?? start.line ?? 0,
			endColumn: end.character ?? start.character ?? 0,
			severity: severity === 1 ? "error" : "warning",
			message: (d.message ?? "").slice(0, 2000),
			...(d.source ? { source: d.source } : {}),
		});
	}
	return out;
}

// ─── the client ──────────────────────────────────────────────────────────────

export interface LspClientOptions {
	/** The server's working directory inside the container (absolute). */
	root: string;
	initializationOptions?: unknown;
	/** Answers workspace/configuration (by section) and is sent once via
	 *  didChangeConfiguration. */
	settings?: Record<string, unknown>;
	/** A file's diagnostics changed (path relative to root). */
	onDiagnostics: (path: string, diagnostics: CodeDiagnostic[]) => void;
	/** How long initialize may take (jdtls is slow). */
	initializeTimeoutMs?: number;
}

const uriOf = (root: string, path: string) => `file://${root}/${path.split("/").map(encodeURIComponent).join("/")}`;
const pathOf = (root: string, uri: string): string | null => {
	const prefix = `file://${root}/`;
	if (!uri.startsWith(prefix)) return null;
	try {
		return decodeURIComponent(uri.slice(prefix.length));
	} catch {
		return null;
	}
};

export class LspClient {
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private versions = new Map<string, number>();
	private framer = new LspFramer();
	private closed = false;

	constructor(
		private readonly stdin: Writable,
		stdout: Readable,
		private readonly options: LspClientOptions,
	) {
		stdout.on("data", (chunk: Buffer) => {
			for (const message of this.framer.push(chunk)) this.dispatch(message as Record<string, unknown>);
		});
		const fail = () => {
			this.closed = true;
			for (const p of this.pending.values()) p.reject(new Error("the language server exited"));
			this.pending.clear();
		};
		stdout.on("end", fail);
		stdout.on("close", fail);
		stdout.on("error", fail);
	}

	get root(): string {
		return this.options.root;
	}

	private write(message: unknown): void {
		if (this.closed) return;
		try {
			this.stdin.write(frame(message));
		} catch {
			this.closed = true;
		}
	}

	request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			if (this.closed) return reject(new Error("the language server exited"));
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	private respond(id: unknown, result: unknown): void {
		this.write({ jsonrpc: "2.0", id, result });
	}

	private dispatch(message: Record<string, unknown>): void {
		const method = typeof message.method === "string" ? message.method : null;
		if (method === null) {
			// A response to one of ours.
			const p = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
			if (!p) return;
			this.pending.delete(message.id as number);
			if (message.error) p.reject(new Error(String((message.error as { message?: unknown }).message ?? "error")));
			else p.resolve(message.result);
			return;
		}
		if ("id" in message) {
			// A request from the server: answer the few that block servers.
			const params = message.params as Record<string, unknown> | undefined;
			switch (method) {
				case "workspace/configuration": {
					const items = (params?.items as Array<{ section?: string }> | undefined) ?? [];
					this.respond(message.id, items.map((i) => this.section(i.section)));
					return;
				}
				case "workspace/workspaceFolders":
					this.respond(message.id, [{ uri: `file://${this.options.root}`, name: "workspace" }]);
					return;
				default:
					// client/registerCapability, window/workDoneProgress/create,
					// window/showMessageRequest, … — acknowledge with null.
					this.respond(message.id, null);
					return;
			}
		}
		if (method === "textDocument/publishDiagnostics") {
			const params = message.params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined;
			const path = params?.uri ? pathOf(this.options.root, params.uri) : null;
			if (path === null) return;
			this.options.onDiagnostics(path, normalizeDiagnostics(path, params?.diagnostics ?? []));
		}
	}

	/** A settings section ("java.project" → settings.java.project). */
	private section(name?: string): unknown {
		const settings = this.options.settings ?? {};
		if (!name) return settings;
		let node: unknown = settings;
		for (const part of name.split(".")) {
			if (typeof node !== "object" || node === null) return null;
			node = (node as Record<string, unknown>)[part];
		}
		return node ?? null;
	}

	/** initialize + initialized (+ the settings, once). */
	async initialize(): Promise<void> {
		const root = this.options.root;
		await this.request(
			"initialize",
			{
				processId: null,
				rootUri: `file://${root}`,
				rootPath: root,
				workspaceFolders: [{ uri: `file://${root}`, name: "workspace" }],
				capabilities: {
					textDocument: {
						synchronization: { didSave: true, dynamicRegistration: false },
						publishDiagnostics: { relatedInformation: false, versionSupport: false },
					},
					workspace: { configuration: true, workspaceFolders: true, didChangeConfiguration: { dynamicRegistration: false } },
					window: { workDoneProgress: false },
				},
				...(this.options.initializationOptions !== undefined ? { initializationOptions: this.options.initializationOptions } : {}),
			},
			this.options.initializeTimeoutMs ?? 120_000,
		);
		this.notify("initialized", {});
		if (this.options.settings) this.notify("workspace/didChangeConfiguration", { settings: this.options.settings });
	}

	/** Open or update a file (full text), then report it saved — some
	 *  servers (rust-analyzer's cargo check) only check on save. */
	sync(path: string, languageId: string, text: string): void {
		const uri = uriOf(this.options.root, path);
		const version = this.versions.get(path);
		if (version === undefined) {
			this.versions.set(path, 1);
			this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
		} else {
			this.versions.set(path, version + 1);
			this.notify("textDocument/didChange", { textDocument: { uri, version: version + 1 }, contentChanges: [{ text }] });
		}
		this.notify("textDocument/didSave", { textDocument: { uri }, text });
	}

	/** Ask the server to exit (best effort). */
	async shutdown(): Promise<void> {
		try {
			await this.request("shutdown", null, 3_000);
			this.notify("exit", null);
		} catch {
			// it may already be gone
		}
		this.closed = true;
		try {
			this.stdin.end();
		} catch {
			// ignore
		}
	}
}
