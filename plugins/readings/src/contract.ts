/**
 * Readings — the pure core shared by the backend and the frontend (no IO, no
 * node builtins). Ported from the fork's src/core/readings.ts,
 * src/core/reading-discussions.ts and their contracts (docs/readings.md in
 * the fork). Doctrine: readings never steer a lesson and never count as
 * evidence; only Discuss exchanges reach the teacher, as a marker note.
 */

// ─── kinds, modes, records ─────────────────────────────────────────────────

export type ReadingKind = "primer" | "overview" | "deep-dive" | "recap" | "node";
export type ReadingMode = "researched" | "model";
export type ReadingStatus = "queued" | "writing" | "ready" | "error";
export type PlanNodeStatus = "current" | "visited" | "upcoming";

export const READING_KINDS: readonly ReadingKind[] = ["primer", "overview", "deep-dive", "recap", "node"];
export const READING_MODES: readonly ReadingMode[] = ["researched", "model"];
export const READING_KIND_LABEL: Readonly<Record<ReadingKind, string>> = {
	primer: "Primer",
	overview: "Overview",
	"deep-dive": "Deep dive",
	recap: "Recap",
	node: "Deep dive",
};
/** Owner ruling (2026-10-27): researched is the default source mode. */
export const DEFAULT_READING_MODE: ReadingMode = "researched";

export interface ReadingAnchor {
	chatId?: string;
	planNodeId?: string;
	planVersion?: number;
	messageId?: string;
	passage?: string;
	nodeIds?: string[];
	topic?: string;
	suggestionCallId?: string;
}
export interface ReadingProposition { id: string; name: string; statement: string }
export interface ReadingSnapshot {
	sessionTitle?: string;
	assessment?: string;
	plan?: string;
	focus?: { title: string; summary?: string };
	upcoming?: string[];
	planNodes?: Array<{ id: string; title: string }>;
	transcript?: string;
	transcriptTrimmed?: boolean;
	propositions?: ReadingProposition[];
	chains?: string[];
}
export interface ReadingSource { title: string; url: string }
export interface FurtherReadingItem extends ReadingSource { why: string; level?: "intro" | "standard" | "advanced" }
export interface GlossaryTerm { term: string; definition: string }
export interface OverviewSection { heading: string; body: string; planNodeIds?: string[] }

export interface ReadingRecord {
	id: string;
	kind: ReadingKind;
	mode: ReadingMode;
	status: ReadingStatus;
	title: string;
	request?: string;
	anchor: ReadingAnchor;
	snapshot: ReadingSnapshot;
	body?: string;
	terms?: GlossaryTerm[];
	sections?: OverviewSection[];
	sources?: ReadingSource[];
	furtherReading?: FurtherReadingItem[];
	activity?: string;
	supersedes?: string;
	error?: string;
	/** Usage as the old host recorded it (imported records), or the worker's. */
	usage?: unknown;
	/** The host worker task writing this reading (plugin era). */
	taskId?: string;
	/** Set on records imported from the fork's data/readings store. */
	importedFrom?: "fork-host";
	createdAt: string;
	updatedAt: string;
	version?: number;
}
export const CURRENT_READING_VERSION = 1;

export type ReadingSummary = Omit<ReadingRecord, "snapshot" | "body" | "terms" | "sections" | "furtherReading" | "sources"> & { chatTitle?: string };

export interface ReadingRequest {
	kind: ReadingKind;
	mode?: ReadingMode;
	request?: string;
	chatId?: string;
	planNodeId?: string;
	messageId?: string;
	passage?: string;
	nodeIds?: string[];
	topic?: string;
	suggestionCallId?: string;
	rerunOf?: string;
}

export const SUGGEST_READING_TOOL = "suggest_reading";
export const SUGGEST_READING_ACK =
	"Offer shown to the learner. Nothing is written unless he opts in, and he may never read it: never build on it, never assume he read it — keep teaching.";

export function isReadingKind(v: unknown): v is ReadingKind {
	return typeof v === "string" && (READING_KINDS as readonly string[]).includes(v);
}
export function isReadingMode(v: unknown): v is ReadingMode {
	return typeof v === "string" && (READING_MODES as readonly string[]).includes(v);
}
export function readingIsLive(r: Pick<ReadingRecord, "status">): boolean {
	return r.status === "queued" || r.status === "writing";
}

// ─── limits + request validation ───────────────────────────────────────────

export const TRANSCRIPT_BUDGET: Readonly<Record<ReadingKind, number>> = { recap: 160_000, "deep-dive": 60_000, primer: 30_000, overview: 30_000, node: 0 };
export const MAX_REQUEST_CHARS = 2_000;
export const MAX_PASSAGE_CHARS = 4_000;
export const MAX_TOPIC_CHARS = 500;
export const MAX_NODE_PICKS = 64;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function str(v: unknown, max: number): string | undefined {
	if (typeof v !== "string") return undefined;
	const t = v.trim();
	return t ? t.slice(0, max) : undefined;
}

export function parseReadingRequest(body: unknown): Parsed<ReadingRequest> {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "Body must be a JSON object" };
	const b = body as Record<string, unknown>;
	if (typeof b.rerunOf === "string" && b.rerunOf) {
		if (b.mode !== undefined && !isReadingMode(b.mode)) return { ok: false, error: "mode must be researched or model" };
		return { ok: true, value: { kind: "recap", rerunOf: b.rerunOf, ...(isReadingMode(b.mode) ? { mode: b.mode } : {}) } };
	}
	if (!isReadingKind(b.kind)) return { ok: false, error: "kind must be one of primer, overview, deep-dive, recap, node" };
	if (b.mode !== undefined && !isReadingMode(b.mode)) return { ok: false, error: "mode must be researched or model" };
	const value: ReadingRequest = { kind: b.kind };
	if (isReadingMode(b.mode)) value.mode = b.mode;
	const set = <K extends keyof ReadingRequest>(key: K, v: ReadingRequest[K] | undefined) => { if (v !== undefined) value[key] = v; };
	set("request", str(b.request, MAX_REQUEST_CHARS));
	set("chatId", str(b.chatId, 200));
	set("planNodeId", str(b.planNodeId, 200));
	set("messageId", str(b.messageId, 200));
	set("passage", str(b.passage, MAX_PASSAGE_CHARS));
	set("topic", str(b.topic, MAX_TOPIC_CHARS));
	set("suggestionCallId", str(b.suggestionCallId, 200));
	if (Array.isArray(b.nodeIds)) {
		const ids = [...new Set(b.nodeIds.filter((x): x is string => typeof x === "string" && x.length > 0))].slice(0, MAX_NODE_PICKS);
		if (ids.length > 0) value.nodeIds = ids;
	}
	switch (value.kind) {
		case "primer":
			if (!value.chatId && !value.topic) return { ok: false, error: "A primer needs a session (chatId) or a topic" };
			break;
		case "overview":
			if (!value.chatId && !value.topic) return { ok: false, error: "An overview needs a session (chatId) or a topic" };
			break;
		case "deep-dive":
			if (!value.chatId) return { ok: false, error: "A deep dive needs a session (chatId)" };
			if (!value.planNodeId && !value.passage) return { ok: false, error: "A deep dive needs a plan node or a passage" };
			break;
		case "recap":
			if (!value.chatId) return { ok: false, error: "A recap needs a session (chatId)" };
			break;
		case "node":
			if (!value.nodeIds) return { ok: false, error: "A node reading needs at least one proposition (nodeIds)" };
			break;
	}
	return { ok: true, value };
}

// ─── the native session, structurally ──────────────────────────────────────

export interface PlanTreeLike { nodes: Array<{ id: string; title: string; summary?: string }>; edges: Array<{ from: string; to: string }>; version?: number }
type Block = { type?: string; text?: string; id?: string; name?: string; arguments?: unknown };
export type MessageLike = { role?: string; id?: string; content?: unknown; toolName?: string; isError?: boolean; details?: unknown; customType?: string };
export interface SnapshotChat { title: string; messages: readonly MessageLike[]; tree?: PlanTreeLike }

function blocksOf(m: MessageLike): Block[] {
	return Array.isArray(m.content) ? (m.content as Block[]) : [];
}

/**
 * Plan position from teach-check CALLS (the host's derivePlanStatusesLh): current =
 * node of the most recent tagged check, visited = nodes of earlier stays. A
 * plugin cannot read the host's plugin-question annotation, so any tool call
 * whose arguments carry a known plan `nodeId` counts (quiz/explain and plugin
 * teach questions both carry it).
 */
export function derivePlanStatuses(tree: PlanTreeLike, messages: readonly MessageLike[]): { current: string | null; visited: Set<string> } {
	const ids = new Set(tree.nodes.map((n) => n.id));
	const runs: string[] = [];
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const block of blocksOf(m)) {
			if (block.type !== "toolCall") continue;
			const nodeId = (block.arguments as { nodeId?: unknown } | undefined)?.nodeId;
			if (typeof nodeId !== "string" || !ids.has(nodeId)) continue;
			if (runs.at(-1) !== nodeId) runs.push(nodeId);
		}
	}
	return { current: runs.at(-1) ?? null, visited: new Set(runs.slice(0, -1)) };
}
export function nodeStatus(statuses: { current: string | null; visited: ReadonlySet<string> }, id: string): PlanNodeStatus {
	return statuses.current === id ? "current" : statuses.visited.has(id) ? "visited" : "upcoming";
}

export function assessmentText(messages: readonly MessageLike[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "assistant") continue;
		for (const block of blocksOf(m)) {
			if (block.type !== "toolCall" || block.name !== "probe_done") continue;
			const a = (block.arguments as { assessment?: { strands?: unknown; summary?: unknown } } | undefined)?.assessment;
			if (!a || typeof a !== "object") continue;
			const lines: string[] = [];
			if (typeof a.summary === "string" && a.summary.trim()) lines.push(`Summary: ${a.summary.trim()}`);
			if (Array.isArray(a.strands)) {
				for (const s of a.strands as Array<{ strand?: unknown; assessment?: unknown }>) {
					if (typeof s?.strand === "string") lines.push(`- ${s.strand}: ${typeof s.assessment === "string" ? s.assessment : ""}`.trimEnd());
				}
			}
			if (lines.length > 0) return lines.join("\n");
		}
	}
	return undefined;
}

export function planText(tree: PlanTreeLike | undefined, messages: readonly MessageLike[]): string | undefined {
	if (!tree || tree.nodes.length === 0) return undefined;
	const statuses = derivePlanStatuses(tree, messages);
	const title = new Map(tree.nodes.map((n) => [n.id, n.title] as const));
	const lines = tree.nodes.map((n) => `- [${nodeStatus(statuses, n.id)}] ${n.title} (${n.id})${n.summary ? ` — ${n.summary}` : ""}`);
	if (tree.edges.length > 0) {
		lines.push("Requires (prerequisite → dependent):");
		for (const e of tree.edges) lines.push(`- ${title.get(e.from) ?? e.from} → ${title.get(e.to) ?? e.to}`);
	}
	return lines.join("\n");
}

function userText(content: unknown): string[] {
	if (typeof content === "string") return content.trim() ? [content] : [];
	return (Array.isArray(content) ? (content as Block[]) : []).filter((b) => b.type === "text" && typeof b.text === "string" && b.text.trim()).map((b) => b.text!);
}

/**
 * The session as markdown for the writer — a simplified port of the host's
 * sessionMarkdown (which is private): learner text, tutor text, posed
 * questions and the learner's check answers. Failed tool calls and custom
 * markers are left out, as there.
 */
export function transcriptMarkdown(messages: readonly MessageLike[]): string {
	const out: string[] = [];
	for (const m of messages) {
		if (m.role === "user") {
			for (const t of userText(m.content)) out.push(`### Learner\n\n${t.trim()}`);
		} else if (m.role === "assistant") {
			for (const b of blocksOf(m)) {
				if (b.type === "text" && typeof b.text === "string" && b.text.trim()) out.push(`### Teacher\n\n${b.text.trim()}`);
				const q = (b.arguments as { question?: unknown } | undefined)?.question;
				if (b.type === "toolCall" && typeof q === "string" && q.trim()) out.push(`### Question\n\n${q.trim()}`);
			}
		} else if (m.role === "toolResult" && !m.isError) {
			const d = (m.details ?? {}) as Record<string, unknown>;
			const lines: string[] = [];
			if (d.dismissed === true) lines.push("The learner skipped this check.");
			else if (d.dontKnow === true) lines.push("The learner did not know.");
			else if (d.correct === true) lines.push("The learner answered correctly.");
			else if (d.correct === false) lines.push("The learner answered incorrectly.");
			else if (typeof d.text === "string" && d.text.trim()) lines.push(`The learner answered in his own words: ${d.text.trim()}`);
			if (typeof d.note === "string" && d.note.trim()) lines.push(`*(his thinking: ${d.note.trim()})*`);
			if (lines.length > 0) out.push(`### Learner answer\n\n${lines.join("\n\n")}`);
		}
	}
	return out.join("\n\n");
}

export function budgetTranscript(markdown: string, budget: number): { text: string; trimmed: boolean } {
	if (budget <= 0) return { text: "", trimmed: markdown.length > 0 };
	if (markdown.length <= budget) return { text: markdown, trimmed: false };
	const head = Math.floor(budget * 0.2);
	const tail = budget - head;
	return {
		text: `${markdown.slice(0, head)}\n\n[… ${markdown.length - budget} characters of the middle of the session omitted …]\n\n${markdown.slice(markdown.length - tail)}`,
		trimmed: true,
	};
}

export function buildSessionSnapshot(
	kind: Exclude<ReadingKind, "node">,
	chat: SnapshotChat,
	anchor: { planNodeId?: string; passage?: string },
	propositions?: ReadingProposition[],
): Parsed<ReadingSnapshot> {
	const snapshot: ReadingSnapshot = { sessionTitle: chat.title };
	const assessment = assessmentText(chat.messages);
	if (assessment) snapshot.assessment = assessment;
	const plan = planText(chat.tree, chat.messages);
	if (plan) snapshot.plan = plan;
	const tree = chat.tree;
	const upcoming = (except?: string) => {
		const statuses = derivePlanStatuses(tree!, chat.messages);
		return tree!.nodes.filter((n) => n.id !== except && nodeStatus(statuses, n.id) === "upcoming").map((n) => n.title);
	};
	if (kind === "deep-dive" && anchor.planNodeId) {
		const node = tree?.nodes.find((n) => n.id === anchor.planNodeId);
		if (!node) return { ok: false, error: `Unknown plan node: ${anchor.planNodeId}` };
		snapshot.focus = { title: node.title, ...(node.summary ? { summary: node.summary } : {}) };
		snapshot.upcoming = upcoming(node.id);
	} else if (kind === "deep-dive" && tree) {
		snapshot.upcoming = upcoming();
	} else if (kind === "overview" && tree && tree.nodes.length > 0) {
		snapshot.planNodes = tree.nodes.map((n) => ({ id: n.id, title: n.title }));
		snapshot.upcoming = upcoming();
	}
	const budget = TRANSCRIPT_BUDGET[kind];
	if (budget > 0) {
		const md = transcriptMarkdown(chat.messages);
		if (md.trim()) {
			const { text, trimmed } = budgetTranscript(md, budget);
			snapshot.transcript = text;
			if (trimmed) snapshot.transcriptTrimmed = true;
		}
	}
	if (kind === "recap" && propositions && propositions.length > 0) snapshot.propositions = propositions;
	if (kind === "recap" && !snapshot.transcript) return { ok: false, error: "This session has nothing to recap yet" };
	return { ok: true, value: snapshot };
}

export function planNodeStatuses(chat: SnapshotChat, nodeIds: readonly string[]): Record<string, PlanNodeStatus> {
	if (!chat.tree || nodeIds.length === 0) return {};
	const statuses = derivePlanStatuses(chat.tree, chat.messages);
	const present = new Set(chat.tree.nodes.map((n) => n.id));
	const out: Record<string, PlanNodeStatus> = {};
	for (const id of nodeIds) if (present.has(id)) out[id] = nodeStatus(statuses, id);
	return out;
}

export function provisionalTitle(
	kind: ReadingKind,
	ctx: { focus?: string; passage?: string; sessionTitle?: string; topic?: string; propositions?: ReadingProposition[] },
): string {
	const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
	switch (kind) {
		case "primer":
			return `Key terms: ${clip(ctx.topic ?? ctx.sessionTitle ?? "this lesson")}`;
		case "overview":
			return `Overview: ${clip(ctx.topic ?? ctx.sessionTitle ?? "this lesson")}`;
		case "recap":
			return `Recap: ${clip(ctx.sessionTitle ?? "session")}`;
		case "deep-dive":
			return ctx.focus ? `Deep dive: ${clip(ctx.focus)}` : `Deep dive: “${clip(ctx.passage ?? "passage", 48)}”`;
		case "node": {
			const names = (ctx.propositions ?? []).map((p) => p.name);
			return `Deep dive: ${clip(names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : ""))}`;
		}
	}
}

// ─── the citation law ──────────────────────────────────────────────────────

export function normalizeUrl(raw: string): string {
	try {
		const u = new URL(raw.trim());
		u.hash = "";
		const s = `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname}${u.search}`;
		return s.endsWith("/") ? s.slice(0, -1) : s;
	} catch {
		return raw.trim();
	}
}

export function urlsInText(text: string): string[] {
	const out = new Set<string>();
	for (const m of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) out.add(m[0].replace(/[.,;:!?]+$/, ""));
	return [...out];
}

export function citationProblems(cited: ReadonlyArray<Pick<ReadingSource, "url">>, fetched: ReadonlySet<string>, mode: ReadingMode): string[] {
	if (mode === "model") {
		return cited.length > 0 ? ["This reading is written from model knowledge only: sources and further reading must be empty (no web access was used)."] : [];
	}
	return cited
		.filter(({ url }) => !fetched.has(normalizeUrl(url)))
		.map(({ url }) => `Cited URL was never successfully fetched in this run: ${url}. Fetch it with web_fetch first, or remove it — only cite pages you actually read.`);
}

export interface SubmittedReading {
	title: string;
	body: string;
	terms: GlossaryTerm[];
	sections: OverviewSection[];
	sources: ReadingSource[];
	furtherReading: FurtherReadingItem[];
}

/** Normalize a worker result (validated against the schema by the host). */
export function fillSubmitted(input: unknown): SubmittedReading {
	const r = (input ?? {}) as Record<string, unknown>;
	const arr = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);
	return {
		title: String(r.title ?? "").trim(),
		body: String(r.body ?? "").trim(),
		terms: arr<GlossaryTerm>(r.terms),
		sections: arr<OverviewSection>(r.sections),
		sources: arr<ReadingSource>(r.sources),
		furtherReading: arr<FurtherReadingItem>(r.furtherReading),
	};
}

export function submittedReadingProblem(
	kind: ReadingKind,
	mode: ReadingMode,
	value: SubmittedReading,
	fetched: ReadonlySet<string>,
	planNodeIds: ReadonlySet<string> = new Set(),
): string | null {
	const problems: string[] = [];
	if (!value.title.trim()) problems.push("title is empty");
	if (kind === "primer") {
		if (value.terms.length < 3) problems.push("a primer needs `terms`: at least 3 glossary entries");
		if (value.terms.some((t) => !t.term.trim() || !t.definition.trim())) problems.push("every term needs a term and a definition");
	} else if (kind === "overview") {
		if (value.terms.length > 0) problems.push("`terms` is for primers only — put the content in `sections`");
		if (value.sections.length < 2) problems.push("an overview needs `sections`: at least 2, in reading order");
		if (value.sections.some((sec) => !sec.heading.trim() || !sec.body.trim())) problems.push("every section needs a heading and a body");
		const unknown = [...new Set(value.sections.flatMap((sec) => sec.planNodeIds ?? []).filter((id) => !planNodeIds.has(id)))];
		if (unknown.length > 0) {
			problems.push(
				planNodeIds.size === 0
					? "There is no lesson plan: every section's `planNodeIds` must be empty."
					: `Unknown plan node ids in planNodeIds: ${unknown.join(", ")} — use only ids from the given plan-node list.`,
			);
		}
		if (value.body.trim().length + value.sections.reduce((n, sec) => n + sec.body.trim().length, 0) < 200) problems.push("the overview is too short to be a reading");
	} else {
		if (value.terms.length > 0) problems.push("`terms` is for primers only — put the content in `body`");
		if (value.body.trim().length < 200) problems.push("the body is too short to be a reading");
	}
	if (kind !== "overview" && value.sections.length > 0) problems.push("`sections` is for overviews only — put the content in `body`");
	if (kind !== "recap" && value.furtherReading.length > 0) problems.push("`furtherReading` is for recaps only — cite sources in `sources`");
	if (kind === "recap" && mode === "researched" && value.furtherReading.length === 0) {
		problems.push("a researched recap needs `furtherReading`: 3-8 sources you fetched, closest to the session first");
	}
	problems.push(...citationProblems([...value.sources, ...value.furtherReading], fetched, mode));
	const inline = urlsInText([value.body, ...value.terms.map((t) => t.definition), ...value.sections.map((sec) => sec.body)].join("\n"));
	if (mode === "model" && inline.length > 0) problems.push("Model-knowledge mode: the text must contain no URLs (no web access was used) — remove the links.");
	else if (mode === "researched") problems.push(...citationProblems(inline.map((url) => ({ url })), fetched, mode));
	return problems.length > 0 ? problems.join("\n") : null;
}

export function cleanSection(sec: OverviewSection): OverviewSection {
	const ids = [...new Set(sec.planNodeIds ?? [])];
	return { heading: sec.heading.trim(), body: sec.body.trim(), ...(ids.length > 0 ? { planNodeIds: ids } : {}) };
}
export function dedupeSources<T extends ReadingSource>(list: T[]): T[] {
	const seen = new Set<string>();
	return list.filter((s) => {
		const k = normalizeUrl(s.url);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

// ─── views of the store ────────────────────────────────────────────────────

export function summarizeReading(r: ReadingRecord): ReadingSummary {
	const { snapshot: _s, body: _b, terms: _t, sections: _sec, furtherReading: _f, sources: _src, ...rest } = r;
	return rest;
}

function supersededIds(readings: ReadonlyArray<Pick<ReadingRecord, "supersedes" | "status">>): Set<string> {
	return new Set(readings.filter((r) => r.supersedes && r.status !== "error").map((r) => r.supersedes as string));
}

/** A session's readings, newest first, superseded versions hidden. */
export function readingsForChat<R extends Pick<ReadingRecord, "id" | "anchor" | "createdAt" | "supersedes" | "status">>(readings: readonly R[], chatId: string): R[] {
	const superseded = supersededIds(readings);
	return readings.filter((r) => r.anchor.chatId === chatId && !superseded.has(r.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function readingMarkdown(
	r: Pick<ReadingRecord, "title" | "kind" | "mode" | "body" | "terms" | "sections" | "sources" | "furtherReading" | "createdAt"> & { snapshot?: Pick<ReadingSnapshot, "planNodes"> },
): string {
	const out: string[] = [`# ${r.title}`];
	out.push(`*${READING_KIND_LABEL[r.kind]} · ${r.mode === "researched" ? "researched" : "written from model knowledge — not source-checked"} · ${r.createdAt.slice(0, 10)}*`);
	if (r.body?.trim()) out.push(r.body.trim());
	if (r.sections && r.sections.length > 0) {
		const titles = new Map((r.snapshot?.planNodes ?? []).map((n) => [n.id, n.title] as const));
		for (const sec of r.sections) {
			const nodes = (sec.planNodeIds ?? []).map((id) => titles.get(id) ?? id);
			out.push(`## ${sec.heading}`);
			if (nodes.length > 0) out.push(`*In your lesson: ${nodes.join(", ")}*`);
			if (sec.body.trim()) out.push(sec.body.trim());
		}
	}
	if (r.terms && r.terms.length > 0) out.push("## Terms", r.terms.map((t) => `**${t.term}** — ${t.definition}`).join("\n\n"));
	if (r.sources && r.sources.length > 0) out.push("## Sources", r.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n"));
	if (r.furtherReading && r.furtherReading.length > 0) {
		out.push("## Further reading", r.furtherReading.map((f) => `- [${f.title}](${f.url})${f.level ? ` *(${f.level})*` : ""} — ${f.why}`).join("\n"));
	}
	return out.join("\n\n") + "\n";
}

// ─── markdown blocks (Discuss placement) ───────────────────────────────────

/**
 * Split markdown into top-level blocks on blank lines, keeping fenced code
 * and $$ math blocks whole, and list items of one list together. Stands in
 * for streamdown's parseMarkdownIntoBlocks, which a plugin cannot import.
 */
export function markdownBlocks(markdown: string): string[] {
	const blocks: string[] = [];
	let cur: string[] = [];
	let fence: string | null = null;
	let math = false;
	const flush = () => {
		const text = cur.join("\n").trim();
		if (text) blocks.push(text);
		cur = [];
	};
	const isList = (line: string) => /^\s*([-*+]|\d+[.)])\s/.test(line);
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (fence) {
			cur.push(line);
			if (line.trim().startsWith(fence)) fence = null;
			continue;
		}
		if (math) {
			cur.push(line);
			if (line.trim().endsWith("$$")) math = false;
			continue;
		}
		const open = /^\s*(```+|~~~+)/.exec(line);
		if (open) {
			cur.push(line);
			fence = open[1]!;
			continue;
		}
		if (line.trim().startsWith("$$") && !(line.trim().length > 2 && line.trim().endsWith("$$"))) {
			cur.push(line);
			math = true;
			continue;
		}
		if (!line.trim()) {
			// A blank line inside one list (the next non-blank line continues it) keeps the block.
			const next = lines.slice(i + 1).find((l) => l.trim());
			if (cur.length > 0 && next !== undefined && cur.some(isList) && (isList(next) || /^\s{2,}\S/.test(next))) {
				cur.push(line);
				continue;
			}
			flush();
			continue;
		}
		if (/^#{1,6}\s/.test(line)) {
			flush();
			cur.push(line);
			flush();
			continue;
		}
		cur.push(line);
	}
	flush();
	return blocks;
}

export function blockKeys(markdown: string | undefined, prefix: string): string[] {
	return markdown ? markdownBlocks(markdown).map((_, i) => `${prefix}:${i}`) : [];
}

export function renderedBlockKeys(r: Pick<ReadingRecord, "body" | "sections" | "terms">): Set<string> {
	return new Set([
		...blockKeys(r.body, "body"),
		...(r.sections ?? []).flatMap((sec, i) => blockKeys(sec.body, `sec:${i}`)),
		...(r.terms ?? []).flatMap((t, i) => blockKeys(t.definition, `term:${i}`)),
	]);
}

// ─── Discuss ───────────────────────────────────────────────────────────────

export type DiscussionExchangeStatus = "queued" | "answering" | "done" | "error";
export const SIDE_THREAD_ID = "side";
export const MAX_QUESTION_CHARS = 4_000;
export const MARKER_ANSWER_CHARS = 6_000;
/** The E1 marker type that replaces the fork's `reading-discussion` custom message. */
export const DISCUSSED_MARKER_TYPE = "discussed";

export interface DiscussionExchange {
	id: string;
	question: string;
	mode: ReadingMode;
	status: DiscussionExchangeStatus;
	answer?: string;
	sources?: ReadingSource[];
	unverifiedUrls?: string[];
	activity?: string;
	error?: string;
	usage?: unknown;
	askedAt: string;
	answeredAt?: string;
}
export interface DiscussionThread {
	id: string;
	passage?: string;
	blockKey?: string;
	exchanges: DiscussionExchange[];
	createdAt: string;
	/** The host managed-agent conversation answering this thread (plugin era). */
	conversationId?: string;
}
export interface ReadingDiscussionRecord {
	readingId: string;
	side: DiscussionThread;
	threads: DiscussionThread[];
	createdAt: string;
	updatedAt: string;
	version?: number;
}
export interface DiscussionAsk {
	question: string;
	mode: ReadingMode;
	threadId?: string;
	passage?: string;
	blockKey?: string;
}
/** The discussed-line marker's data (the fork's ReadingDiscussionMarkerDetails). */
export interface DiscussedMarkerData {
	chatId: string;
	readingId: string;
	readingTitle: string;
	threadId: string;
	exchangeId: string;
}

export function exchangeIsLive(x: Pick<DiscussionExchange, "status">): boolean {
	return x.status === "queued" || x.status === "answering";
}
export function discussionThreads(r: Pick<ReadingDiscussionRecord, "side" | "threads">): DiscussionThread[] {
	return [r.side, ...r.threads];
}
export function emptyDiscussion(readingId: string, now: string): ReadingDiscussionRecord {
	return { readingId, side: { id: SIDE_THREAD_ID, exchanges: [], createdAt: now }, threads: [], createdAt: now, updatedAt: now };
}

export function parseDiscussionAsk(body: unknown): Parsed<DiscussionAsk> {
	if (typeof body !== "object" || body === null) return { ok: false, error: "Body must be a JSON object" };
	const b = body as Record<string, unknown>;
	const question = str(b.question, MAX_QUESTION_CHARS);
	if (!question) return { ok: false, error: "question is required" };
	if (!isReadingMode(b.mode)) return { ok: false, error: "mode must be researched or model" };
	const value: DiscussionAsk = { question, mode: b.mode };
	const threadId = str(b.threadId, 200);
	const passage = typeof b.passage === "string" ? b.passage.replace(/\s+/g, " ").trim().slice(0, MAX_PASSAGE_CHARS) : "";
	if (threadId && passage) return { ok: false, error: "Give a threadId (continue) or a passage (new thread), not both" };
	if (threadId) value.threadId = threadId;
	if (passage) {
		value.passage = passage;
		const blockKey = str(b.blockKey, 200);
		if (blockKey) value.blockKey = blockKey;
	}
	return { ok: true, value };
}

function linkLabels(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of text.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
		const key = normalizeUrl(m[2]!);
		if (!out.has(key)) out.set(key, m[1]!.trim());
	}
	return out;
}

export function answerCitations(answer: string, fetched: ReadonlySet<string>, mode: ReadingMode): { sources: ReadingSource[]; unverifiedUrls: string[] } {
	const labels = linkLabels(answer);
	const sources: ReadingSource[] = [];
	const unverifiedUrls: string[] = [];
	const seen = new Set<string>();
	for (const url of urlsInText(answer)) {
		const key = normalizeUrl(url);
		if (seen.has(key)) continue;
		seen.add(key);
		if (mode === "researched" && fetched.has(key)) sources.push({ title: labels.get(key) ?? url, url });
		else unverifiedUrls.push(url);
	}
	return { sources, unverifiedUrls };
}

export function markUnverifiedLinks(answer: string, unverifiedUrls: readonly string[]): string {
	if (unverifiedUrls.length === 0) return answer;
	const bad = new Set(unverifiedUrls.map(normalizeUrl));
	const MARK = " *(unverified link)*";
	const linked = answer.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (whole, label: string, url: string) => (bad.has(normalizeUrl(url)) ? `${label}${MARK}` : whole));
	return linked.replace(/(\]\()?(https?:\/\/[^\s<>"'`)\]]+)/g, (whole, linkOpen: string | undefined, raw: string) => {
		if (linkOpen) return whole;
		const url = raw.replace(/[.,;:!?]+$/, "");
		const tail = raw.slice(url.length);
		return bad.has(normalizeUrl(url)) ? `\`${url}\`${MARK}${tail}` : whole;
	});
}

export function placeThreads<T extends Pick<DiscussionThread, "blockKey">>(threads: readonly T[], rendered: ReadonlySet<string>): { inline: Map<string, T[]>; fallback: T[] } {
	const inline = new Map<string, T[]>();
	const fallback: T[] = [];
	for (const t of threads) {
		if (t.blockKey && rendered.has(t.blockKey)) inline.set(t.blockKey, [...(inline.get(t.blockKey) ?? []), t]);
		else fallback.push(t);
	}
	return { inline, fallback };
}

function quote(text: string): string {
	return `> ${text.replace(/\n/g, "\n> ")}`;
}

/** What the teacher reads (owner ruling: the question AND the answer). */
export function discussionMarkerText(input: { readingTitle: string; readingKind: ReadingKind; passage?: string; question: string; answer: string }): string {
	const answer = input.answer.length > MARKER_ANSWER_CHARS ? `${input.answer.slice(0, MARKER_ANSWER_CHARS)}\n\n[…answer trimmed]` : input.answer;
	const out = [
		`Reading discussion — beside the lesson, not part of it. The learner asked a question in the Discuss panel of the reading “${input.readingTitle}” (${READING_KIND_LABEL[input.readingKind]}); a reading companion answered, not you.`,
	];
	if (input.passage) out.push(`The passage the learner asked about:\n${quote(input.passage)}`);
	out.push(`The learner's question:\n${quote(input.question)}`);
	out.push(`The answer the learner was shown:\n${quote(answer)}`);
	return out.join("\n\n");
}

function exchangeMarkdown(x: DiscussionExchange): string[] {
	const out = [`**Q:** ${x.question}`];
	if (x.answer?.trim()) out.push(`**A${x.mode === "model" ? " (AI only — not source-checked)" : ""}:** ${markUnverifiedLinks(x.answer.trim(), x.unverifiedUrls ?? [])}`);
	else if (x.status === "error") out.push(`*No answer${x.error ? `: ${x.error}` : ""}.*`);
	if (x.sources && x.sources.length > 0) out.push(`Sources: ${x.sources.map((s) => `[${s.title}](${s.url})`).join(", ")}`);
	return out;
}

export function discussionMarkdown(r: Pick<ReadingDiscussionRecord, "side" | "threads"> | null | undefined): string {
	if (!r) return "";
	const threads = r.threads.filter((t) => t.exchanges.length > 0);
	if (threads.length === 0 && r.side.exchanges.length === 0) return "";
	const out = ["## Discussion"];
	for (const t of threads) {
		if (t.passage) out.push(quote(t.passage));
		for (const x of t.exchanges) out.push(...exchangeMarkdown(x));
	}
	if (r.side.exchanges.length > 0) {
		out.push("### Side chat");
		for (const x of r.side.exchanges) out.push(...exchangeMarkdown(x));
	}
	return out.join("\n\n") + "\n";
}

// ─── fetch outcome (the plugin-owned web_fetch) ────────────────────────────

/** Did a fetch tool output carry real content? Failures start with "<tool> failed". */
export function fetchSucceeded(toolName: string, output: string): boolean {
	const t = output.trimStart();
	return !t.startsWith(`${toolName} failed`) && t.length > 0;
}

/** HTML → readable text (no DOM on the server; a deliberately small converter). */
export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|h[1-6]|tr|section|article|pre|blockquote)>/gi, "\n")
		.replace(/<li[^>]*>/gi, "- ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n\s*\n+/g, "\n\n")
		.trim();
}
