/**
 * Readings backend: the plugin-owned store, the writer (host workers), the
 * reading companion for Discuss (host managed agents), the teacher's offer
 * tool + doctrine, the discussed-line marker (E1) and the one-time import of
 * the fork's data/readings + data/reading-discussions stores.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginBackendContext, PluginModelSpec, PluginTaskSnapshot, PluginAgentSnapshot } from "learnharness-plugin-api";
import {
	answerCitations,
	buildSessionSnapshot,
	cleanSection,
	CURRENT_READING_VERSION,
	dedupeSources,
	DEFAULT_READING_MODE,
	discussionMarkerText,
	discussionThreads,
	DISCUSSED_MARKER_TYPE,
	emptyDiscussion,
	exchangeIsLive,
	fetchSucceeded,
	fillSubmitted,
	htmlToText,
	normalizeUrl,
	parseDiscussionAsk,
	parseReadingRequest,
	planNodeStatuses,
	provisionalTitle,
	READING_KINDS,
	READING_MODES,
	readingIsLive,
	readingsForChat,
	SIDE_THREAD_ID,
	submittedReadingProblem,
	SUGGEST_READING_ACK,
	SUGGEST_READING_TOOL,
	summarizeReading,
	type DiscussedMarkerData,
	type DiscussionExchange,
	type DiscussionThread,
	type PlanTreeLike,
	type ReadingDiscussionRecord,
	type ReadingKind,
	type ReadingMode,
	type ReadingProposition,
	type ReadingRecord,
	type ReadingRequest,
	type ReadingSnapshot,
	type SnapshotChat,
} from "./contract.ts";
import { companionFollowUpText, companionOpeningText, composeCompanionPrompt, composeWriterPrompt, READING_RESULT_SCHEMA, writerTaskText } from "./writer.ts";
import { TEACHER_READINGS } from "./prompts.ts";

export interface Settings {
	/** The writer role's model: explicit choice, else the strong slot. */
	writerModel: { provider: string; id: string } | null;
	writerThinking?: string;
}
const DEFAULT_SETTINGS: Settings = { writerModel: null };
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const STOPPED = "Stopped";
const INTERRUPTED = "Interrupted (server restarted)";
const COMPANION = "companion";
const MAX_FETCH_BYTES = 2_000_000;
const MAX_FETCH_CHARS = 60_000;

const writerId = (kind: ReadingKind, mode: ReadingMode) => `writer-${kind}-${mode}`;
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const safeId = (id: string) => /^[A-Za-z0-9_-]{1,200}$/.test(id);
const fail = (message: string): never => {
	throw new Error(message);
};

type Json = Record<string, unknown>;
type Tool = { name: string; label: string; description: string; parameters: unknown; execute: (id: string, params: any, signal?: AbortSignal) => Promise<{ content: { type: "text"; text: string }[]; details: unknown }> };
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(value, null, "\t") + "\n", "utf8");
		fs.renameSync(tmp, file);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}
function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** The plugin-owned store under ctx.dataDirectory. */
export function openStore(dataDirectory: string) {
	const readingsDir = path.join(dataDirectory, "readings");
	const discussionsDir = path.join(dataDirectory, "discussions");
	const readingFile = (id: string) => (safeId(id) ? path.join(readingsDir, `${id}.json`) : fail(`Invalid reading id: ${id}`));
	const discussionFile = (id: string) => (safeId(id) ? path.join(discussionsDir, `${id}.json`) : fail(`Invalid reading id: ${id}`));
	const checkVersion = <T extends { version?: number }>(r: T | null): T | null => {
		if (r && (r.version ?? 1) > CURRENT_READING_VERSION) throw new Error("This reading was saved by a newer version of Readings.");
		return r;
	};
	const store = {
		readingsDir,
		discussionsDir,
		getReading: (id: string) => checkVersion(readJson<ReadingRecord>(readingFile(id))),
		putReading(r: ReadingRecord) {
			writeJson(readingFile(r.id), { ...r, version: CURRENT_READING_VERSION });
		},
		updateReading(id: string, patch: Partial<ReadingRecord>): ReadingRecord | null {
			const cur = store.getReading(id);
			if (!cur) return null;
			const next = { ...cur, ...patch, updatedAt: new Date().toISOString() } as ReadingRecord;
			for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (next as unknown as Json)[k];
			store.putReading(next);
			return next;
		},
		listReadings(): ReadingRecord[] {
			let names: string[] = [];
			try {
				names = fs.readdirSync(readingsDir).filter((n) => n.endsWith(".json"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const out: ReadingRecord[] = [];
			for (const n of names) {
				try {
					const r = store.getReading(n.slice(0, -5));
					if (r) out.push(r);
				} catch {
					/* an unreadable or newer record is skipped in lists */
				}
			}
			return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		},
		deleteReading(id: string): boolean {
			const file = readingFile(id);
			if (!fs.existsSync(file)) return false;
			fs.rmSync(file, { force: true });
			fs.rmSync(discussionFile(id), { force: true });
			return true;
		},
		getDiscussion: (id: string) => checkVersion(readJson<ReadingDiscussionRecord>(discussionFile(id))),
		putDiscussion(d: ReadingDiscussionRecord) {
			writeJson(discussionFile(d.readingId), { ...d, version: CURRENT_READING_VERSION, updatedAt: new Date().toISOString() });
		},
	};
	return store;
}
export type Store = ReturnType<typeof openStore>;

/**
 * One-time, idempotent import of the fork's host stores (owner decision:
 * migrate). Copies <learning>/readings/*.json and <learning>/reading-discussions/*.json
 * into the plugin store when the id is not already there; never deletes or
 * rewrites the old files. A reading left mid-write by the old host is
 * imported as interrupted. Returns the ids imported this time.
 */
export function importForkData(learningDirectory: string, store: Store): { readings: string[]; discussions: string[] } {
	const imported = { readings: [] as string[], discussions: [] as string[] };
	const list = (dir: string) => {
		try {
			return fs.readdirSync(dir).filter((n) => n.endsWith(".json") && safeId(n.slice(0, -5)));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	};
	const oldReadings = path.join(learningDirectory, "readings");
	for (const name of list(oldReadings)) {
		const id = name.slice(0, -5);
		if (fs.existsSync(path.join(store.readingsDir, name))) continue;
		let r: ReadingRecord;
		try {
			r = JSON.parse(fs.readFileSync(path.join(oldReadings, name), "utf8")) as ReadingRecord;
		} catch {
			continue;
		}
		if (!r || r.id !== id || (r.version ?? 1) > CURRENT_READING_VERSION || !READING_KINDS.includes(r.kind) || !READING_MODES.includes(r.mode)) continue;
		const settled: ReadingRecord = readingIsLive(r) ? { ...r, status: "error", error: INTERRUPTED } : { ...r };
		delete settled.activity;
		store.putReading({ ...settled, anchor: settled.anchor ?? {}, snapshot: settled.snapshot ?? {}, importedFrom: "fork-host" });
		imported.readings.push(id);
	}
	const oldDiscussions = path.join(learningDirectory, "reading-discussions");
	for (const name of list(oldDiscussions)) {
		const id = name.slice(0, -5);
		if (fs.existsSync(path.join(store.discussionsDir, name))) continue;
		if (!fs.existsSync(path.join(store.readingsDir, name))) continue;
		let d: ReadingDiscussionRecord;
		try {
			d = JSON.parse(fs.readFileSync(path.join(oldDiscussions, name), "utf8")) as ReadingDiscussionRecord;
		} catch {
			continue;
		}
		if (!d || d.readingId !== id || !d.side || !Array.isArray(d.threads) || (d.version ?? 1) > CURRENT_READING_VERSION) continue;
		const settle = (t: DiscussionThread): DiscussionThread => ({
			...t,
			exchanges: t.exchanges.map((x) => {
				if (!exchangeIsLive(x)) return x;
				const { activity: _a, ...rest } = x;
				return { ...rest, status: "error" as const, error: INTERRUPTED };
			}),
		});
		writeJson(path.join(store.discussionsDir, name), { ...d, side: settle(d.side), threads: d.threads.map(settle) });
		imported.discussions.push(id);
	}
	return imported;
}

export function activate(ctx: PluginBackendContext): () => void {
	const store = openStore(ctx.dataDirectory);
	const settingsFile = path.join(ctx.dataDirectory, "settings.json");
	const offersFile = path.join(ctx.dataDirectory, "offers.json");
	let settings: Settings = { ...DEFAULT_SETTINGS, ...(readJson<Settings>(settingsFile) ?? {}) };
	const disposers: Array<() => void> = [];
	const alive = () => {
		if (ctx.signal.aborted) throw new Error("Readings is disabled.");
	};
	const changed = (id?: string) => ctx.events.emit("readings-changed", id ? { id } : {});

	// ─── migration ─────────────────────────────────────────────────────────
	try {
		const result = importForkData(ctx.learning.directory, store);
		if (result.readings.length + result.discussions.length > 0) {
			const logFile = path.join(ctx.dataDirectory, "migration.json");
			const log = readJson<{ imports: unknown[] }>(logFile) ?? { imports: [] };
			log.imports.push({ at: new Date().toISOString(), ...result });
			writeJson(logFile, log);
		}
	} catch (error) {
		console.error("[readings] importing the fork's readings failed:", error);
	}

	// ─── models ────────────────────────────────────────────────────────────
	async function resolveModel(): Promise<PluginModelSpec> {
		const catalog = await ctx.inference.catalog();
		alive();
		const pin = settings.writerModel ? { model: settings.writerModel, thinkingLevel: undefined } : catalog.slots?.strong;
		if (!pin?.model) fail("Readings needs a model: configure the strong model slot, or choose a writer model in Readings settings.");
		const entry = catalog.models.find((m) => m.provider === pin!.model.provider && m.id === pin!.model.id);
		if (!entry) fail("The writer model is unavailable. Choose a configured model in Readings settings.");
		const thinking = (settings.writerThinking ?? pin!.thinkingLevel) as PluginModelSpec["thinkingLevel"] | undefined;
		return { ...pin!.model, ...(thinking && entry!.supportedLevels.includes(thinking) ? { thinkingLevel: thinking } : {}) };
	}

	// ─── web tools (plugin-owned: the host's web toolset is not exposed) ───
	function webTools(onActivity: (line: string) => void, fetched: Set<string>, allowed: () => boolean): Tool[] {
		const search: Tool = {
			name: "web_search",
			label: "web_search",
			description: "Search the web.",
			parameters: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
			async execute(_id, params) {
				onActivity(`web_search: ${String(params.query ?? "").slice(0, 80)}`);
				return text("web_search is unavailable: no search provider is available to the Readings plugin. Fetch sources you can name with confidence with web_fetch.");
			},
		};
		const fetchTool: Tool = {
			name: "web_fetch",
			label: "web_fetch",
			description: "Fetch a web page (HTML or text) by URL and return its readable text. PDFs are not supported.",
			parameters: { type: "object", required: ["url"], properties: { url: { type: "string", description: "An http(s) URL" } } },
			async execute(_id, params, signal) {
				const url = String(params.url ?? "");
				if (!allowed()) return text("web_fetch failed: this question is in model-knowledge mode — no web access.");
				onActivity(`web_fetch: ${url.length > 80 ? `${url.slice(0, 79)}…` : url}`);
				const out = await fetchPage(url, signal);
				if (fetchSucceeded("web_fetch", out)) fetched.add(normalizeUrl(url));
				return text(out);
			},
		};
		return [search, fetchTool];
	}
	async function fetchPage(url: string, signal?: AbortSignal): Promise<string> {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return "web_fetch failed: invalid URL";
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "web_fetch failed: only http(s) URLs";
		try {
			const timeout = AbortSignal.timeout(30_000);
			const res = await fetch(parsed, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "follow", headers: { accept: "text/html,text/plain,*/*;q=0.5" } });
			if (!res.ok) return `web_fetch failed: HTTP ${res.status}`;
			const type = res.headers.get("content-type") ?? "";
			if (/pdf/i.test(type) || /\.pdf($|\?)/i.test(parsed.pathname)) return "web_fetch failed: PDFs are not supported by this fetch tool";
			const buf = await res.arrayBuffer();
			if (buf.byteLength > MAX_FETCH_BYTES) return "web_fetch failed: page too large";
			const raw = new TextDecoder().decode(buf);
			const body = /html/i.test(type) || /^\s*</.test(raw) ? htmlToText(raw) : raw.trim();
			if (!body) return "web_fetch failed: empty page";
			return body.length > MAX_FETCH_CHARS ? `${body.slice(0, MAX_FETCH_CHARS)}\n\n[…truncated]` : body;
		} catch (error) {
			return `web_fetch failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	// ─── the writer (host workers) ─────────────────────────────────────────
	const fetchedByTask = new Map<string, Set<string>>();
	const watched = new Set<string>();
	const setActivity = (readingId: string, line: string) => {
		store.updateReading(readingId, { activity: line });
		changed(readingId);
	};
	for (const kind of READING_KINDS) {
		for (const mode of READING_MODES) {
			disposers.push(
				ctx.workers.register({
					id: writerId(kind, mode),
					instructions: composeWriterPrompt(kind, mode),
					resultSchema: READING_RESULT_SCHEMA as never,
					tools:
						mode === "researched"
							? (context) => {
									const fetched = new Set<string>();
									fetchedByTask.set(context.taskId, fetched);
									const readingId = (context.input as { readingId?: string } | undefined)?.readingId ?? "";
									return webTools((line) => setActivity(readingId, line), fetched, () => true) as never;
								}
							: undefined,
					validateResult(result, context) {
						const readingId = (context.input as { readingId?: string } | undefined)?.readingId ?? "";
						const record = store.getReading(readingId);
						const problem = submittedReadingProblem(kind, mode, fillSubmitted(result), fetchedByTask.get(context.taskId) ?? new Set(), new Set((record?.snapshot.planNodes ?? []).map((n) => n.id)));
						if (problem) throw new Error(problem);
					},
				}),
			);
		}
	}

	function applyOutcome(readingId: string, task: PluginTaskSnapshot): void {
		const record = store.getReading(readingId);
		if (!record || record.taskId !== task.id || !readingIsLive(record)) return;
		fetchedByTask.delete(task.id);
		const usage = task.usage ? { usage: task.usage } : {};
		if (task.status === "succeeded") {
			const s = fillSubmitted(task.result);
			store.updateReading(readingId, {
				status: "ready",
				title: s.title || record.title,
				body: s.body,
				...(s.terms.length > 0 ? { terms: s.terms } : {}),
				...(s.sections.length > 0 ? { sections: s.sections.map(cleanSection) } : {}),
				...(s.sources.length > 0 ? { sources: dedupeSources(s.sources) } : {}),
				...(s.furtherReading.length > 0 ? { furtherReading: dedupeSources(s.furtherReading) } : {}),
				...usage,
				activity: undefined,
				error: undefined,
			});
		} else if (task.status === "failed" || task.status === "cancelled" || task.status === "interrupted") {
			const error = task.status === "cancelled" ? STOPPED : task.status === "interrupted" ? INTERRUPTED : (task.error?.message ?? "The writer failed");
			store.updateReading(readingId, { status: "error", error, activity: undefined, ...usage });
		} else {
			store.updateReading(readingId, { status: task.status === "running" ? "writing" : "queued" });
			return;
		}
		changed(readingId);
	}

	function watchTask(readingId: string, taskId: string): void {
		if (watched.has(taskId)) return;
		watched.add(taskId);
		let unsubscribe: (() => void) | undefined;
		try {
			unsubscribe = ctx.workers.subscribe(taskId, (snap) => {
				const record = store.getReading(readingId);
				if (record && record.status === "queued" && snap.status === "running") {
					store.updateReading(readingId, { status: "writing", activity: record.mode === "researched" ? "researching" : "writing" });
					changed(readingId);
				}
			});
		} catch {
			/* unknown task: wait() below reports it */
		}
		ctx.workers
			.wait(taskId, ctx.signal)
			.then(() => applyOutcome(readingId, ctx.workers.get(taskId)))
			.catch(() => undefined)
			.finally(() => {
				unsubscribe?.();
				watched.delete(taskId);
			});
	}

	// Settle what the last server run left behind.
	for (const r of store.listReadings()) {
		if (!readingIsLive(r)) continue;
		let task: PluginTaskSnapshot | null = null;
		try {
			task = r.taskId ? ctx.workers.get(r.taskId) : null;
		} catch {
			task = null;
		}
		if (!task) store.updateReading(r.id, { status: "error", error: INTERRUPTED, activity: undefined });
		else if (["succeeded", "failed", "cancelled", "interrupted"].includes(task.status)) applyOutcome(r.id, task);
		else watchTask(r.id, task.id);
	}

	function graphPropositions(ids: readonly string[]): ReadingProposition[] {
		const byId = new Map(ctx.learning.graph().propositions.map((n) => [n.id, n] as const));
		return ids.flatMap((id) => {
			const n = byId.get(id);
			return n ? [{ id: n.id, name: n.name, statement: n.statement }] : [];
		});
	}
	function bornIn(chatId: string): ReadingProposition[] {
		const born = ctx.learning
			.graph()
			.propositions.filter((n) => n.provenance?.[0]?.chatId === chatId)
			.sort((a, b) => (a.id < b.id ? -1 : 1));
		return born.map((n) => ({ id: n.id, name: n.name, statement: n.statement }));
	}
	function nodeChains(props: ReadingProposition[]): string[] {
		const selected = new Set(props.map((p) => p.id));
		const names = new Map(props.map((p) => [p.id, p.name] as const));
		return ctx.learning
			.graph()
			.chains.filter((c) => c.premises.length > 0 && selected.has(c.conclusion) && c.premises.every((p) => selected.has(p)))
			.map((c) => `${[...c.premises].sort().map((p) => names.get(p) ?? p).join(", ")} → ${names.get(c.conclusion) ?? c.conclusion}`);
	}
	function chatFor(chatId: string): (SnapshotChat & { kind?: string }) | null {
		const chat = ctx.learning.getSession(chatId);
		return chat ? { title: chat.title, messages: chat.messages as never, tree: chat.tree as PlanTreeLike | undefined, kind: chat.kind } : null;
	}

	async function createReading(raw: unknown): Promise<ReadingRecord> {
		const parsed = parseReadingRequest(raw);
		if (!parsed.ok) fail(parsed.error);
		const req = (parsed as { value: ReadingRequest }).value;
		let base = req;
		let supersedes: string | undefined;
		if (req.rerunOf) {
			const original = store.getReading(req.rerunOf) ?? fail("Unknown reading");
			const a = original.anchor;
			base = { kind: original.kind, mode: req.mode ?? original.mode, ...(original.request ? { request: original.request } : {}), ...a };
			delete (base as unknown as Json).planVersion;
			delete (base as unknown as Json).rerunOf;
			supersedes = original.id;
		}
		const model = await resolveModel();
		let snapshot: ReadingSnapshot;
		let planVersion: number | undefined;
		let title: string;
		if (base.kind === "node") {
			const props = graphPropositions(base.nodeIds ?? []);
			if (props.length === 0) fail("None of the picked propositions exist in the graph");
			const chains = nodeChains(props);
			snapshot = { propositions: props, ...(chains.length > 0 ? { chains } : {}) };
			title = provisionalTitle("node", { propositions: props });
		} else if (base.chatId) {
			const chat = chatFor(base.chatId) ?? fail("Unknown session");
			if (chat.kind === "practice") fail("Readings attach to teaching sessions");
			const built = buildSessionSnapshot(base.kind, chat, { planNodeId: base.planNodeId, passage: base.passage }, base.kind === "recap" ? bornIn(base.chatId) : undefined);
			if (!built.ok) fail(built.error);
			snapshot = (built as { value: ReadingSnapshot }).value;
			planVersion = chat.tree?.version;
			title = provisionalTitle(base.kind, { focus: snapshot.focus?.title, passage: base.passage, sessionTitle: chat.title });
		} else {
			snapshot = {};
			title = provisionalTitle(base.kind, { topic: base.topic });
		}
		alive();
		const now = new Date().toISOString();
		const record: ReadingRecord = {
			id: newId("rd"),
			kind: base.kind,
			mode: base.mode ?? DEFAULT_READING_MODE,
			status: "queued",
			title,
			...(base.request ? { request: base.request } : {}),
			anchor: {
				...(base.chatId ? { chatId: base.chatId } : {}),
				...(base.planNodeId ? { planNodeId: base.planNodeId } : {}),
				...(planVersion !== undefined && base.planNodeId ? { planVersion } : {}),
				...(base.messageId ? { messageId: base.messageId } : {}),
				...(base.passage ? { passage: base.passage } : {}),
				...(base.kind === "node" && snapshot.propositions ? { nodeIds: snapshot.propositions.map((p) => p.id) } : {}),
				...(base.topic && !base.chatId ? { topic: base.topic } : {}),
				...(base.suggestionCallId ? { suggestionCallId: base.suggestionCallId } : {}),
			},
			snapshot,
			...(supersedes ? { supersedes } : {}),
			createdAt: now,
			updatedAt: now,
		};
		store.putReading(record);
		try {
			const task = ctx.workers.start(writerId(record.kind, record.mode), {
				requestId: record.id,
				input: { readingId: record.id },
				prompt: writerTaskText(record),
				model,
				purpose: "user",
				maxTurns: record.mode === "researched" ? 28 : 3,
			});
			store.updateReading(record.id, { taskId: task.id });
			watchTask(record.id, task.id);
		} catch (error) {
			store.updateReading(record.id, { status: "error", error: error instanceof Error ? error.message : String(error) });
		}
		changed(record.id);
		return store.getReading(record.id)!;
	}

	function stopReading(id: string): boolean {
		const r = store.getReading(id);
		if (!r || !readingIsLive(r) || !r.taskId) return false;
		try {
			ctx.workers.cancel(r.taskId);
		} catch {
			return false;
		}
		return true;
	}

	// ─── Discuss (host managed agents) ─────────────────────────────────────
	interface LiveAnswer {
		readingId: string;
		threadId: string;
		exchangeId: string;
		conversationId: string;
		mode: ReadingMode;
		fetched: Set<string>;
		from: number;
		stopping: boolean;
		text: string;
		activity: string;
		unsubscribe?: () => void;
	}
	const liveByConversation = new Map<string, LiveAnswer>();
	let companion: { spec: string; dispose: () => void } | null = null;

	async function ensureCompanion(): Promise<void> {
		const model = await resolveModel();
		const spec = JSON.stringify(model);
		if (companion?.spec === spec) return;
		if (companion && liveByConversation.size > 0) return; // keep the running definition until answers settle
		companion?.dispose();
		const dispose = ctx.agents.register({
			id: COMPANION,
			instructions: composeCompanionPrompt(),
			model,
			maxTurns: 28,
			tools: webTools(
				() => undefined,
				new Set(),
				() => false,
			).map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters as never,
				// Bound per call to the conversation's live answer (its mode and fetch log).
				execute: async (toolCallId: string, params: Json, signal?: AbortSignal) => {
					const live = [...liveByConversation.values()].find((l) => !l.stopping && l.activity !== "done");
					const bound = live ? webTools((line) => updateLive(live, { activity: line }), live.fetched, () => live.mode === "researched") : webTools(() => undefined, new Set(), () => false);
					return bound.find((t) => t.name === tool.name)!.execute(toolCallId, params, signal);
				},
			})) as never,
		});
		companion = { spec, dispose };
	}

	function emitAnswer(live: LiveAnswer) {
		ctx.events.emit("answer", { readingId: live.readingId, exchangeId: live.exchangeId, text: live.text, activity: live.activity });
	}
	function updateLive(live: LiveAnswer, patch: Partial<Pick<LiveAnswer, "text" | "activity">>) {
		Object.assign(live, patch);
		emitAnswer(live);
	}

	function mutateDiscussion(readingId: string, fn: (d: ReadingDiscussionRecord) => void): ReadingDiscussionRecord {
		const d = store.getDiscussion(readingId) ?? emptyDiscussion(readingId, new Date().toISOString());
		fn(d);
		store.putDiscussion(d);
		return d;
	}
	function patchExchange(readingId: string, threadId: string, exchangeId: string, patch: Partial<DiscussionExchange>) {
		return mutateDiscussion(readingId, (d) => {
			const thread = discussionThreads(d).find((t) => t.id === threadId);
			const x = thread?.exchanges.find((e) => e.id === exchangeId);
			if (!x) return;
			Object.assign(x, patch);
			for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (x as unknown as Json)[k];
		});
	}

	function finalText(snapshot: PluginAgentSnapshot, from: number): string {
		const fresh = snapshot.messages.slice(from) as Array<{ role?: string; content?: unknown }>;
		for (let i = fresh.length - 1; i >= 0; i--) {
			const m = fresh[i]!;
			if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
			const t = (m.content as Array<{ type?: string; text?: string }>).filter((b) => b.type === "text" && b.text).map((b) => b.text).join("");
			if (t.trim()) return t.trim();
		}
		return "";
	}

	function settleAnswer(live: LiveAnswer, snapshot: PluginAgentSnapshot) {
		live.activity = "done";
		live.unsubscribe?.();
		liveByConversation.delete(live.conversationId);
		const answer = finalText(snapshot, live.from) || live.text.trim();
		const reading = store.getReading(live.readingId);
		if (!reading) return;
		if (live.stopping || snapshot.status === "error" || snapshot.status === "interrupted" || !answer) {
			patchExchange(live.readingId, live.threadId, live.exchangeId, {
				status: "error",
				error: live.stopping ? STOPPED : snapshot.status === "interrupted" ? INTERRUPTED : (snapshot.error ?? "The companion finished without an answer."),
				...(answer ? { answer } : {}),
				activity: undefined,
			});
		} else {
			const { sources, unverifiedUrls } = answerCitations(answer, live.fetched, live.mode);
			const d = patchExchange(live.readingId, live.threadId, live.exchangeId, {
				status: "done",
				answer,
				...(sources.length > 0 ? { sources } : {}),
				...(unverifiedUrls.length > 0 ? { unverifiedUrls } : {}),
				answeredAt: new Date().toISOString(),
				activity: undefined,
				error: undefined,
			});
			const thread = discussionThreads(d).find((t) => t.id === live.threadId);
			const exchange = thread?.exchanges.find((e) => e.id === live.exchangeId);
			if (thread && exchange) void notifyTeacher(reading, thread, exchange);
		}
		ctx.events.emit("discussion-changed", { readingId: live.readingId });
	}

	/** E1 marker: a held note for the teacher (never a wake) + the quiet discussed line. */
	async function notifyTeacher(reading: ReadingRecord, thread: DiscussionThread, exchange: DiscussionExchange) {
		const chatId = reading.anchor.chatId;
		if (!chatId || !exchange.answer) return;
		const chat = ctx.learning.getSession(chatId);
		if (!chat || chat.kind === "practice") return;
		const data: DiscussedMarkerData = { chatId, readingId: reading.id, readingTitle: reading.title, threadId: thread.id, exchangeId: exchange.id };
		try {
			await ctx.markers.append(chatId, {
				typeId: DISCUSSED_MARKER_TYPE,
				details: data,
				modelText: discussionMarkerText({ readingTitle: reading.title, readingKind: reading.kind, ...(thread.passage ? { passage: thread.passage } : {}), question: exchange.question, answer: exchange.answer }),
				idempotencyKey: `rdq_${exchange.id}`,
			});
		} catch (error) {
			console.error("[readings] the discussed marker was not delivered:", error);
		}
	}

	async function ask(raw: Json): Promise<{ threadId: string; exchangeId: string }> {
		const readingId = String(raw.readingId ?? "");
		const reading = store.getReading(readingId) ?? fail("Unknown reading");
		if (reading.status !== "ready") fail("Only a finished reading can be discussed");
		const parsed = parseDiscussionAsk(raw);
		if (!parsed.ok) fail(parsed.error);
		const a = (parsed as { value: import("./contract.ts").DiscussionAsk }).value;
		await ensureCompanion();
		alive();
		const now = new Date().toISOString();
		const exchange: DiscussionExchange = { id: newId("dx"), question: a.question, mode: a.mode, status: "queued", askedAt: now };
		const threadId = a.passage ? newId("dt") : (a.threadId ?? SIDE_THREAD_ID);
		let thread: DiscussionThread | undefined;
		mutateDiscussion(readingId, (d) => {
			if (a.passage) {
				thread = { id: threadId, passage: a.passage, ...(a.blockKey ? { blockKey: a.blockKey } : {}), exchanges: [], createdAt: now };
				d.threads.push(thread);
			} else thread = discussionThreads(d).find((t) => t.id === threadId);
			if (!thread) fail("Unknown thread");
			if (thread!.exchanges.some(exchangeIsLive)) fail("This thread is still answering");
			thread!.exchanges.push(exchange);
		});
		const t = thread!;
		let conversationId = t.conversationId;
		let opening = false;
		try {
			if (conversationId) {
				try {
					ctx.agents.get(conversationId);
				} catch {
					conversationId = undefined;
				}
			}
			if (!conversationId) {
				conversationId = ctx.agents.create(COMPANION).id;
				opening = true;
				mutateDiscussion(readingId, (d) => {
					const found = discussionThreads(d).find((x) => x.id === threadId);
					if (found) found.conversationId = conversationId;
				});
			}
			const from = ctx.agents.get(conversationId).messages.length;
			const live: LiveAnswer = { readingId, threadId, exchangeId: exchange.id, conversationId, mode: a.mode, fetched: new Set(), from, stopping: false, text: "", activity: "answering" };
			liveByConversation.set(conversationId, live);
			const message = opening ? companionOpeningText(reading, t, exchange) : companionFollowUpText(exchange);
			await ctx.agents.send(conversationId, message, { requestId: exchange.id, purpose: "user" });
			patchExchange(readingId, threadId, exchange.id, { status: "answering", activity: "answering" });
			live.unsubscribe = ctx.agents.subscribe(conversationId, (snap) => {
				if (live.activity === "done") return;
				if (snap.status === "running") {
					const partial = snap.partial as { content?: Array<{ type?: string; text?: string }> } | undefined;
					const streamed = (partial?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
					const committed = finalText(snap, live.from);
					updateLive(live, { text: streamed || committed });
				} else queueMicrotask(() => live.activity !== "done" && settleAnswer(live, snap));
			});
		} catch (error) {
			if (conversationId) liveByConversation.delete(conversationId);
			patchExchange(readingId, threadId, exchange.id, { status: "error", error: error instanceof Error ? error.message : String(error), activity: undefined });
		}
		ctx.events.emit("discussion-changed", { readingId });
		return { threadId, exchangeId: exchange.id };
	}

	function stopAnswer(exchangeId: string): boolean {
		const live = [...liveByConversation.values()].find((l) => l.exchangeId === exchangeId);
		if (!live) return false;
		live.stopping = true;
		try {
			ctx.agents.abort(live.conversationId);
		} catch {
			return false;
		}
		return true;
	}

	function discussionView(readingId: string) {
		const d = store.getDiscussion(readingId) ?? emptyDiscussion(readingId, new Date().toISOString());
		const liveText = new Map([...liveByConversation.values()].map((l) => [l.exchangeId, l] as const));
		const view = (t: DiscussionThread) => ({
			...t,
			exchanges: t.exchanges.map((x) => {
				const live = liveText.get(x.id);
				if (exchangeIsLive(x) && !live) return { ...x, status: "error" as const, error: INTERRUPTED, activity: undefined };
				return live ? { ...x, answer: live.text, activity: live.activity } : x;
			}),
		});
		return { ...d, side: view(d.side), threads: d.threads.map(view) };
	}

	// ─── the teacher: offer tool + doctrine ────────────────────────────────
	type Offer = { chatId: string; kind: "primer" | "deep-dive" | "recap"; planNodeId?: string; title: string };
	const offers = (): Record<string, Offer> => readJson<Record<string, Offer>>(offersFile) ?? {};
	disposers.push(ctx.registerInstructions({ agents: ["teacher"], text: TEACHER_READINGS }));
	disposers.push(
		ctx.registerTools({
			agents: ["teacher"],
			create: (context) => [
				{
					name: SUGGEST_READING_TOOL,
					label: SUGGEST_READING_TOOL,
					description:
						"OFFER the learner an optional reading — a written document he can open beside the lesson. Nothing is generated unless he clicks; " +
						"he may never read it. Offer when he shows curiosity beyond the lesson's path (a detour worth taking OUTSIDE the session), or a " +
						"primer of terms right after presenting the plan, or a recap near a natural end. Never as a substitute for teaching a step, never " +
						"to defer a question he asked, at most occasionally. Does not end your turn.",
					parameters: {
						type: "object",
						required: ["kind", "title", "why"],
						properties: {
							kind: {
								type: "string",
								enum: ["deep-dive", "primer", "recap"],
								description: "deep-dive = the fuller story of one plan node (set planNodeId); primer = the lesson's key terms as definitions; recap = a record of what this session built.",
							},
							planNodeId: { type: "string", description: "deep-dive only: the plan node slug, exactly as in plan_init." },
							title: { type: "string", description: "Short title for the offer card, e.g. 'Where the chain rule comes from'." },
							why: { type: "string", description: "One sentence to the learner: what the reading would add, outside the lesson's path." },
						},
					},
					execute: async (toolCallId: string, input: { kind: Offer["kind"]; planNodeId?: string; title: string; why: string }) => {
						const problems: string[] = [];
						if (!["deep-dive", "primer", "recap"].includes(input.kind)) problems.push("kind must be deep-dive, primer or recap");
						if (!String(input.title ?? "").trim()) problems.push("title is empty");
						if (!String(input.why ?? "").trim()) problems.push("why is empty");
						if (input.kind === "deep-dive") {
							if (!input.planNodeId) problems.push("a deep-dive offer needs planNodeId");
							else {
								const known = (ctx.learning.getSession(context.chatId)?.tree?.nodes ?? []).map((n) => n.id);
								if (!known.includes(input.planNodeId)) problems.push(`planNodeId "${input.planNodeId}" matches no node in this session's plan map`);
							}
						}
						if (problems.length > 0) throw new Error(`Invalid ${SUGGEST_READING_TOOL} input:\n- ${problems.join("\n- ")}`);
						const all = offers();
						all[toolCallId] = { chatId: context.chatId, kind: input.kind, ...(input.planNodeId ? { planNodeId: input.planNodeId } : {}), title: input.title };
						writeJson(offersFile, all);
						return text(SUGGEST_READING_ACK);
					},
				} as never,
			],
		}),
	);

	// ─── the frontend bridge ───────────────────────────────────────────────
	const register = (name: string, handler: (input: Json) => unknown) =>
		disposers.push(
			ctx.handle(name, (input = {}) => {
				alive();
				if (!input || typeof input !== "object" || Array.isArray(input)) fail("Invalid operation input.");
				return handler(input as Json);
			}),
		);
	const titles = () => new Map(ctx.learning.listSessions().map((c) => [c.id, c.title] as const));
	register("list", (input) => {
		const all = store.listReadings();
		const t = titles();
		const rows = typeof input.chatId === "string" ? readingsForChat(all, input.chatId) : all;
		return rows.map((r) => ({ ...summarizeReading(r), ...(r.anchor.chatId && t.get(r.anchor.chatId) ? { chatTitle: t.get(r.anchor.chatId) } : {}) }));
	});
	register("get", (input) => {
		const r = store.getReading(String(input.id ?? ""));
		if (!r) return null;
		const practice = r.anchor.nodeIds ? graphPropositions(r.anchor.nodeIds) : r.anchor.chatId ? bornIn(r.anchor.chatId) : [];
		const chat = r.anchor.chatId ? chatFor(r.anchor.chatId) : null;
		const tagged = (r.sections ?? []).flatMap((s) => s.planNodeIds ?? []);
		const planStatus = chat && tagged.length > 0 ? planNodeStatuses(chat, tagged) : undefined;
		return { ...r, practice, ...(chat ? { chatTitle: chat.title } : {}), ...(planStatus ? { planStatus } : {}) };
	});
	register("create", async (input) => ({ id: (await createReading(input)).id }));
	register("stop", (input) => ({ ok: stopReading(String(input.id ?? "")) }));
	register("delete", (input) => {
		const id = String(input.id ?? "");
		stopReading(id);
		for (const live of [...liveByConversation.values()].filter((l) => l.readingId === id)) stopAnswer(live.exchangeId);
		const ok = store.deleteReading(id);
		if (ok) changed(id);
		return { ok };
	});
	register("discussion", (input) => {
		const id = String(input.readingId ?? "");
		return store.getReading(id) ? discussionView(id) : null;
	});
	register("ask", (input) => ask(input));
	register("stop-answer", (input) => ({ ok: stopAnswer(String(input.exchangeId ?? "")) }));
	register("offer", (input) => {
		const toolCallId = String(input.toolCallId ?? "");
		const offer = offers()[toolCallId];
		if (!offer) return null;
		const written = store.listReadings().find((r) => r.anchor.suggestionCallId === toolCallId && r.status !== "error");
		return { chatId: offer.chatId, ...(written ? { readingId: written.id } : {}) };
	});
	register("accept-offer", async (input) => {
		const toolCallId = String(input.toolCallId ?? "");
		const offer = offers()[toolCallId] ?? fail("Unknown offer");
		const r = await createReading({ kind: offer.kind, chatId: offer.chatId, ...(offer.planNodeId ? { planNodeId: offer.planNodeId } : {}), suggestionCallId: toolCallId, mode: input.mode });
		return { id: r.id, chatId: offer.chatId };
	});
	register("plan", (input) => {
		const chat = chatFor(String(input.chatId ?? ""));
		return { nodes: (chat?.tree?.nodes ?? []).map((n) => ({ id: n.id, title: n.title })), kind: chat?.kind ?? null };
	});
	register("get-settings", () => ({ ...settings }));
	register("get-catalog", () => ctx.inference.catalog());
	register("save-settings", (patch) => {
		const next: Settings = { ...settings };
		if ("writerModel" in patch) {
			const m = patch.writerModel as Settings["writerModel"];
			if (m !== null && (!m || typeof m.provider !== "string" || typeof m.id !== "string")) fail("Invalid model.");
			next.writerModel = m ? { provider: m.provider, id: m.id } : null;
			delete next.writerThinking;
		}
		if ("writerThinking" in patch) {
			const t = patch.writerThinking;
			if (t === null || t === undefined) delete next.writerThinking;
			else if (typeof t !== "string" || !THINKING.includes(t)) fail("Invalid thinking level.");
			else next.writerThinking = t;
		}
		writeJson(settingsFile, next);
		settings = next;
		ctx.events.emit("settings-changed", { ...settings });
		return { ...settings };
	});

	// A turn in a session may move an overview's plan-node chips.
	disposers.push(
		ctx.events.on((event) => {
			if ((event as { type?: string }).type === "turn-settled") ctx.events.emit("session-settled", { chatId: (event as { chatId?: string }).chatId ?? null });
		}),
	);

	const dispose = () => {
		for (const live of liveByConversation.values()) live.unsubscribe?.();
		liveByConversation.clear();
		companion?.dispose();
		companion = null;
		for (const d of disposers.splice(0).reverse()) d();
	};
	ctx.cleanup(dispose);
	return dispose;
}
