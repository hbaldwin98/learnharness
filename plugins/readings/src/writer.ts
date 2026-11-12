/** Writer and companion prompt composition (pure). Ported from the fork's
 * src/agent/subagents/readings.ts and reading-discussions.ts. */
import * as P from "./prompts.ts";
import { readingMarkdown, type DiscussionExchange, type DiscussionThread, type ReadingKind, type ReadingMode, type ReadingRecord } from "./contract.ts";

const SHARED = [P.SHARED_VOICE, P.SHARED_ACCURACY, P.SHARED_FORMATTING];
const KIND_PROMPT: Record<ReadingKind, string> = {
	primer: P.WRITER_KIND_PRIMER,
	overview: P.WRITER_KIND_OVERVIEW,
	"deep-dive": P.WRITER_KIND_DEEP_DIVE,
	recap: P.WRITER_KIND_RECAP,
	node: P.WRITER_KIND_NODE,
};

/** The host submits through submit_result({ result }); the fork's prompts name
 * the old `submit_reading` tool, so the composed prompt says which tool it is. */
const SUBMIT_NOTE =
	"In this harness the `submit_reading` call is the `submit_result` tool: pass the reading as its `result` object (title, body, and the kind's fields). It is validated — citations must be pages you fetched — and returns problems to fix if it fails.";

export function composeWriterPrompt(kind: ReadingKind, mode: ReadingMode): string {
	return [P.WRITER_BASE, mode === "researched" ? P.WRITER_MODE_RESEARCHED : P.WRITER_MODE_MODEL, KIND_PROMPT[kind], ...SHARED, SUBMIT_NOTE].join("\n\n---\n\n");
}

export function writerTaskText(r: Pick<ReadingRecord, "kind" | "mode" | "request" | "anchor" | "snapshot" | "title">): string {
	const s = r.snapshot;
	const out: string[] = [];
	const kindLine: Record<ReadingKind, string> = {
		primer: "Write a PRIMER: the key terms of this lesson, as definitions.",
		overview: "Write an OVERVIEW: the map of this whole topic, section by section.",
		"deep-dive": "Write a DEEP DIVE on the focus below.",
		recap: "Write a RECAP of this session.",
		node: "Write a DEEP DIVE on the propositions below, from his knowledge map.",
	};
	out.push(`# Task\n\n${kindLine[r.kind]} Source mode: ${r.mode === "researched" ? "researched (use the web tools; cite only what you fetched)" : "model knowledge only (no sources)"}.`);
	if (r.request) out.push(`# His request\n\n${r.request}`);
	if (r.anchor.topic) out.push(`# Topic (no session yet)\n\n${r.anchor.topic}`);
	if (s.sessionTitle) out.push(`# Session\n\n${s.sessionTitle}`);
	if (s.focus) out.push(`# Focus — the plan node\n\n${s.focus.title}${s.focus.summary ? ` — ${s.focus.summary}` : ""}`);
	if (r.anchor.passage) out.push(`# Focus — the passage he selected\n\n> ${r.anchor.passage.replace(/\n/g, "\n> ")}`);
	if (s.upcoming && s.upcoming.length > 0) out.push(`# Not yet reached in his lesson (name only — never explain)\n\n${s.upcoming.map((t) => `- ${t}`).join("\n")}`);
	if (s.assessment) out.push(`# The probe's read of where he stands\n\n${s.assessment}`);
	if (s.plan) out.push(`# The lesson plan (statuses: visited / current / upcoming)\n\n${s.plan}`);
	if (s.planNodes && s.planNodes.length > 0) out.push(`# Plan nodes a section may tag (planNodeIds — exact ids only)\n\n${s.planNodes.map((n) => `- \`${n.id}\` — ${n.title}`).join("\n")}`);
	if (s.propositions && s.propositions.length > 0) {
		out.push(`# Propositions${r.kind === "recap" ? " extracted from this session" : ""}\n\n${s.propositions.map((p) => `- **${p.name}** — ${p.statement}`).join("\n")}`);
	}
	if (s.chains && s.chains.length > 0) out.push(`# Reasoning chains among them (premises ⟹ conclusion)\n\n${s.chains.map((c) => `- ${c}`).join("\n")}`);
	if (s.transcript) out.push(`# The session transcript${s.transcriptTrimmed ? " (trimmed: the opening and the most recent stretch)" : ""}\n\n<transcript>\n${s.transcript}\n</transcript>`);
	out.push("Finish with one submit_result call carrying the reading.");
	return out.join("\n\n");
}

const str = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
const source = { type: "object", required: ["title", "url"], properties: { title: str("The source's title"), url: str("The exact URL you fetched") } };

/** The reading result schema (the fork's submit_reading parameters). */
export const READING_RESULT_SCHEMA = {
	type: "object",
	required: ["title", "body"],
	properties: {
		title: str("Short, specific title (a heading, not a sentence)."),
		body: str("The whole reading in markdown (no title heading at the top). Primers and overviews: a short intro only."),
		terms: {
			type: "array",
			description: "PRIMERS ONLY: the glossary, in dependency order.",
			items: { type: "object", required: ["term", "definition"], properties: { term: str(), definition: str("A real definition, 1-3 sentences, LaTeX for notation.") } },
		},
		sections: {
			type: "array",
			description: "OVERVIEWS ONLY: the article, in reading order.",
			items: {
				type: "object",
				required: ["heading", "body"],
				properties: {
					heading: str("The section's heading."),
					body: str("The section in markdown (no heading at the top)."),
					planNodeIds: { type: "array", items: str(), description: "Ids of the lesson-plan nodes this section maps to — from the given list only; empty when none." },
				},
			},
		},
		sources: { type: "array", items: source, description: "Researched mode: every source the body relies on — fetched pages only." },
		furtherReading: {
			type: "array",
			description: "RECAPS ONLY, researched mode: 3-8 fetched sources, closest first.",
			items: {
				type: "object",
				required: ["title", "url", "why"],
				properties: {
					title: str(),
					url: str("The exact URL you fetched"),
					why: str("One sentence: what it adds from where the session left off."),
					level: { type: "string", enum: ["intro", "standard", "advanced"] },
				},
			},
		},
	},
} as const;

// ─── the reading companion (Discuss) ───────────────────────────────────────

export function composeCompanionPrompt(): string {
	return [
		P.COMPANION_BASE,
		"Each question names its source mode. The two modes follow.",
		P.COMPANION_MODE_RESEARCHED,
		P.COMPANION_MODE_MODEL,
		...SHARED,
	].join("\n\n---\n\n");
}

function quote(text: string): string {
	return `> ${text.replace(/\n/g, "\n> ")}`;
}

export function modeLine(mode: ReadingMode): string {
	return `Source mode for this question: ${mode === "researched" ? "researched (web tools available; link only pages you fetched)" : "model knowledge only (no web access, no URLs)"}.`;
}

/** The first message of a thread's conversation: the reading, what it was
 * written from (minus the transcript), any earlier exchanges (imported
 * threads), and the question. Later questions send modeLine + question. */
export function companionOpeningText(
	reading: Pick<ReadingRecord, "title" | "kind" | "mode" | "body" | "terms" | "sections" | "sources" | "furtherReading" | "createdAt" | "snapshot" | "anchor">,
	thread: Pick<DiscussionThread, "passage" | "exchanges">,
	exchange: Pick<DiscussionExchange, "id" | "question" | "mode">,
): string {
	const s = reading.snapshot;
	const out: string[] = [];
	out.push(`# Task\n\nAnswer the learner's questions about the reading below, in this conversation. ${modeLine(exchange.mode)}`);
	out.push(`# The reading\n\n<reading>\n${readingMarkdown(reading).trim()}\n</reading>`);
	if (reading.anchor.topic) out.push(`# The topic it was written for\n\n${reading.anchor.topic}`);
	if (s.sessionTitle) out.push(`# The lesson it sits beside\n\n${s.sessionTitle}`);
	if (s.assessment) out.push(`# The probe's read of where the learner stands (when the reading was written)\n\n${s.assessment}`);
	if (s.plan) out.push(`# The lesson plan (when the reading was written; statuses: visited / current / upcoming)\n\n${s.plan}`);
	if (s.propositions && s.propositions.length > 0) out.push(`# Propositions from the learner's knowledge map\n\n${s.propositions.map((p) => `- **${p.name}** — ${p.statement}`).join("\n")}`);
	if (s.chains && s.chains.length > 0) out.push(`# Reasoning chains among them (premises ⟹ conclusion)\n\n${s.chains.map((c) => `- ${c}`).join("\n")}`);
	if (thread.passage) out.push(`# The passage the learner selected\n\n${quote(thread.passage)}`);
	const earlier = thread.exchanges.filter((x) => x.id !== exchange.id && x.status === "done" && x.answer);
	if (earlier.length > 0) out.push(`# This thread so far\n\n${earlier.map((x) => `**Learner:** ${x.question}\n\n**You:** ${x.answer}`).join("\n\n---\n\n")}`);
	out.push(`# The question now\n\n${exchange.question}`);
	return out.join("\n\n");
}

export function companionFollowUpText(exchange: Pick<DiscussionExchange, "question" | "mode">): string {
	return `${modeLine(exchange.mode)}\n\n${exchange.question}`;
}
