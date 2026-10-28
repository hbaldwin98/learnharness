/** Learner-authored diagrams: a ```mermaid fence inside the plain thinking /
 * answer text (no separate field — the text reaches the model verbatim).
 * Line-based: a fence opens and closes on its own line. Non-mermaid fences
 * are skipped whole, so a ```mermaid line inside a ```js block is literal. */

export interface LearnerTextSegment {
	kind: "text" | "mermaid";
	content: string;
}

const MERMAID_OPEN = /^[ \t]*```[ \t]*mermaid[ \t]*$/;
const OTHER_OPEN = /^[ \t]*```/;
const CLOSE = /^[ \t]*```[ \t]*$/;

interface Line {
	text: string;
	start: number;
	end: number; // index of the line's "\n" (or text.length)
}

function lines(text: string): Line[] {
	const out: Line[] = [];
	let start = 0;
	for (;;) {
		const nl = text.indexOf("\n", start);
		const end = nl === -1 ? text.length : nl;
		out.push({ text: text.slice(start, end), start, end });
		if (nl === -1) return out;
		start = nl + 1;
	}
}

interface Fence {
	/** Line indexes; close is null for a fence left open at the end. */
	open: number;
	close: number | null;
}

function mermaidFences(all: Line[]): Fence[] {
	const fences: Fence[] = [];
	for (let i = 0; i < all.length; i++) {
		const line = all[i]!.text;
		if (!OTHER_OPEN.test(line)) continue;
		let j = i + 1;
		while (j < all.length && !CLOSE.test(all[j]!.text)) j++;
		const close = j < all.length ? j : null;
		if (MERMAID_OPEN.test(line)) fences.push({ open: i, close });
		if (close === null) break;
		i = close;
	}
	return fences;
}

/** Split learner text into plain runs and mermaid charts. A trailing
 *  unclosed fence counts as a chart (the live preview renders mid-typing).
 *  The newline joining a text run to a fence is dropped; whitespace-only
 *  runs vanish. */
export function splitMermaidFences(text: string): LearnerTextSegment[] {
	const all = lines(text);
	const fences = mermaidFences(all);
	if (fences.length === 0) return text.length > 0 ? [{ kind: "text", content: text }] : [];
	const segments: LearnerTextSegment[] = [];
	const pushText = (from: number, to: number) => {
		const run = text.slice(from, to).replace(/^\n/, "").replace(/\n$/, "");
		if (run.trim().length > 0) segments.push({ kind: "text", content: run });
	};
	let cursor = 0;
	for (const fence of fences) {
		pushText(cursor, all[fence.open]!.start);
		const bodyEnd = fence.close === null ? all.length : fence.close;
		const body = all.slice(fence.open + 1, bodyEnd).map((l) => l.text).join("\n");
		segments.push({ kind: "mermaid", content: body });
		cursor = fence.close === null ? text.length : all[fence.close]!.end;
	}
	pushText(cursor, text.length);
	return segments;
}

/** True when the caret sits inside a mermaid fence — from the end of the
 *  opener line up to the start of the closer line (or anywhere after an
 *  unclosed opener). The docks let Enter insert a newline there. */
export function isInsideMermaidFence(text: string, cursor: number): boolean {
	const all = lines(text);
	return mermaidFences(all).some((fence) => {
		if (cursor < all[fence.open]!.end) return false;
		return fence.close === null || cursor <= all[fence.close]!.start;
	});
}

/** Replace the selection with `snippet`, padding with newlines so the
 *  snippet sits on its own lines. `cursorInSnippet` is where the caret
 *  lands, as an offset into the snippet (default: its end). */
export function insertSnippet(
	text: string,
	selStart: number,
	selEnd: number,
	snippet: string,
	cursorInSnippet = snippet.length,
): { text: string; cursor: number } {
	const before = text.slice(0, selStart);
	const after = text.slice(selEnd);
	const prefix = before === "" || before.endsWith("\n") ? "" : "\n";
	const suffix = after === "" || after.startsWith("\n") ? "" : "\n";
	return {
		text: `${before}${prefix}${snippet}${suffix}${after}`,
		cursor: before.length + prefix.length + cursorInSnippet,
	};
}
