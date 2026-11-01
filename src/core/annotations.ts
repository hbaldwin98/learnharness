/**
 * CODE ANNOTATIONS (practice workspaces, plan step 7; owner ruling: the
 * agent annotates, never edits). A note pinned to a line range of one of
 * the learner's files. It moves with its code: each save re-anchors it by
 * the text of the lines it was attached to — still there → unchanged;
 * moved → the nearest exact match; gone → outdated (kept, listed apart).
 * Pure and browser-safe.
 */

export interface CodeAnnotation {
	id: string;
	path: string;
	/** 1-based, inclusive. */
	line: number;
	endLine: number;
	note: string;
	at: string;
	/** The annotated lines' text when attached (what re-anchoring looks for). */
	anchor: string[];
	/** The lines it was attached to are gone (kept in the outdated list). */
	outdated?: boolean;
}

/** At most this many live annotations per problem; notes are this long at most. */
export const MAX_ANNOTATIONS = 20;
export const MAX_ANNOTATION_CHARS = 600;

const linesOf = (content: string): string[] => content.split("\n");

/** The annotated lines' text in `content` (for the anchor). */
export function anchorOf(content: string, line: number, endLine: number): string[] {
	return linesOf(content).slice(line - 1, endLine);
}

/** Move an annotation with its code after `content` changed. */
export function reanchor(a: CodeAnnotation, content: string): CodeAnnotation {
	if (a.outdated) return a;
	const lines = linesOf(content);
	const n = a.anchor.length;
	const matchesAt = (start: number) => n > 0 && a.anchor.every((text, k) => lines[start + k] === text);
	if (matchesAt(a.line - 1)) return a;
	let best = -1;
	for (let i = 0; i + n <= lines.length; i++) {
		if (matchesAt(i) && (best < 0 || Math.abs(i - (a.line - 1)) < Math.abs(best - (a.line - 1)))) best = i;
	}
	if (best < 0) return { ...a, outdated: true };
	return { ...a, line: best + 1, endLine: best + n };
}
