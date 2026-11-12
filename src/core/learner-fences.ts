/** Learner-text fences (fork extension E8): learner answer/thinking text stays
 * plain, but ``` fenced blocks render through the host code-block registry.
 * Line-based: a fence opens and closes on its own line. A trailing unclosed
 * fence is reported as incomplete (the live preview renders mid-typing). */

export type LearnerTextSegment =
	| { kind: "text"; content: string }
	| { kind: "fence"; language: string; meta: string; content: string; incomplete: boolean; raw: string };

const OPEN = /^[ \t]*```[ \t]*([^\s`]*)[ \t]*(.*)$/;
const CLOSE = /^[ \t]*```[ \t]*$/;

/** Split learner text into plain runs and fences. The newline joining a run to a
 * fence is dropped; whitespace-only runs beside fences vanish. Text without any
 * fence comes back unchanged as one run. */
export function splitLearnerFences(text: string): LearnerTextSegment[] {
	const lines = text.split("\n");
	const out: LearnerTextSegment[] = [];
	let run: string[] = [];
	const flush = () => { const content = run.join("\n"); if (content.trim()) out.push({ kind: "text", content }); run = []; };
	for (let i = 0; i < lines.length; i++) {
		const open = OPEN.exec(lines[i]!);
		if (!open) { run.push(lines[i]!); continue; }
		let j = i + 1;
		while (j < lines.length && !CLOSE.test(lines[j]!)) j++;
		flush();
		const closed = j < lines.length;
		out.push({ kind: "fence", language: open[1]!.toLowerCase(), meta: open[2]!.trim(), content: lines.slice(i + 1, j).join("\n"), incomplete: !closed,
			raw: lines.slice(i, closed ? j + 1 : j).join("\n") });
		i = j;
	}
	flush();
	// No fence: the text is returned exactly as written (whitespace included).
	return out.some(segment => segment.kind === "fence") ? out : [{ kind: "text", content: text }];
}
