/**
 * THE TRACE BUNDLE (owner ruling 2026-11-01, ported): one bundle per delivery
 * carrying everything since the agent last looked — timestamped narration,
 * each Run's result, a line diff of the code against what it last saw (the
 * whole file when that is smaller), and the current editor errors/warnings.
 */

import { lineDiff } from "./line-diff.ts";
import type { CodeDiagnostic, NarrationLine, RunRecord } from "./protocol.ts";

/** Agent-facing output cap per stream (the learner sees up to 64 KiB). */
export const AGENT_OUTPUT_CAP_BYTES = 8 * 1024;

export interface TraceInput {
	language: string;
	narration: readonly NarrationLine[];
	runs: readonly RunRecord[];
	/** The code the agent last saw (null: never). */
	seenCode: string | null;
	code: string;
	diagnostics: readonly CodeDiagnostic[];
}

/** A wall-clock time for model text and the strip ("14:03"). */
export function clockTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function capText(text: string, capBytes = AGENT_OUTPUT_CAP_BYTES): string {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= capBytes) return text;
	const tail = new TextDecoder().decode(bytes.subarray(bytes.length - capBytes)).replace(/^�+/, "");
	return `… (${bytes.length - capBytes} bytes truncated)\n${tail}`;
}

function codeSection(t: TraceInput): string | null {
	const fence = (body: string, lang = "") => `\`\`\`${lang}\n${body.replace(/\n?$/, "\n")}\`\`\``;
	if (t.seenCode === null) return `Their code now:\n${fence(t.code, t.language.toLowerCase())}`;
	const diff = lineDiff(t.seenCode, t.code);
	if (diff === "") return null;
	if (diff === null || diff.length > t.code.length) return `Their code now (changed since you last saw it):\n${fence(t.code, t.language.toLowerCase())}`;
	return `Changes to their code since you last saw it:\n${fence(diff, "diff")}`;
}

export function traceIsEmpty(t: TraceInput): boolean {
	return t.narration.length === 0 && t.runs.length === 0 && t.seenCode === t.code && t.diagnostics.length === 0;
}

/** The model-facing trace text (headline first, then sections). */
export function formatTrace(headline: string, t: TraceInput): string {
	const parts = [headline];
	if (t.narration.length) parts.push(`Narration:\n${t.narration.map(n => `[${clockTime(n.at)}] ${n.text}`).join("\n")}`);
	for (const run of t.runs) {
		const r = run.result;
		const lines = [`Run at ${clockTime(run.at)} (the problem's tests): ${r.status}${r.exitCode === null ? "" : ` (exit ${r.exitCode})`}${r.message ? ` — ${r.message}` : ""}${r.notice ? ` [${r.notice}]` : ""}`];
		if (r.stdout.trim()) lines.push(`stdout:\n${capText(r.stdout)}`);
		if (r.stderr.trim()) lines.push(`stderr:\n${capText(r.stderr)}`);
		parts.push(lines.join("\n"));
	}
	const code = codeSection(t);
	if (code) parts.push(code);
	if (t.diagnostics.length) {
		parts.push(`Editor ${t.diagnostics.length === 1 ? "problem" : "problems"} (language server):\n${t.diagnostics
			.map(d => `line ${d.line + 1}:${d.column + 1} ${d.severity}: ${d.message}`).join("\n")}`);
	}
	return parts.join("\n\n");
}
