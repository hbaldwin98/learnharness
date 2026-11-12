/**
 * A small line diff (practice workspaces, plan step 5): the trace sends
 * the agent each file's changes since the code it last saw, as unified
 * hunks with two lines of context. Pure and dependency-free; files are
 * small (the pose caps them), and a pair too large for the LCS table
 * falls back to the whole new file.
 */

/** Above this many LCS cells the diff gives up and sends the file. */
const MAX_CELLS = 4_000_000;
const CONTEXT = 2;

type Op = { kind: " " | "-" | "+"; line: string };

const splitLines = (text: string): string[] => {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
};

function operations(a: string[], b: string[]): Op[] | null {
	// Trim the common head and tail first — most edits are local.
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	const am = a.slice(head, a.length - tail);
	const bm = b.slice(head, b.length - tail);
	if ((am.length + 1) * (bm.length + 1) > MAX_CELLS) return null;
	// LCS lengths from the end, then a forward walk.
	const w = bm.length + 1;
	const t = new Uint32Array((am.length + 1) * w);
	for (let i = am.length - 1; i >= 0; i--) {
		for (let j = bm.length - 1; j >= 0; j--) {
			t[i * w + j] = am[i] === bm[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
		}
	}
	const ops: Op[] = a.slice(0, head).map((line) => ({ kind: " ", line }));
	let i = 0;
	let j = 0;
	while (i < am.length && j < bm.length) {
		if (am[i] === bm[j]) {
			ops.push({ kind: " ", line: am[i]! });
			i++;
			j++;
		} else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) ops.push({ kind: "-", line: am[i++]! });
		else ops.push({ kind: "+", line: bm[j++]! });
	}
	while (i < am.length) ops.push({ kind: "-", line: am[i++]! });
	while (j < bm.length) ops.push({ kind: "+", line: bm[j++]! });
	for (const line of a.slice(a.length - tail)) ops.push({ kind: " ", line });
	return ops;
}

/**
 * Unified hunks turning `before` into `after`, or "" when they're equal,
 * or null when the pair is too large to diff (send the file instead).
 */
export function lineDiff(before: string, after: string): string | null {
	if (before === after) return "";
	const ops = operations(splitLines(before), splitLines(after));
	if (!ops) return null;
	const out: string[] = [];
	let k = 0;
	while (k < ops.length) {
		if (ops[k]!.kind === " ") {
			k++;
			continue;
		}
		// A hunk: back up for context, run until CONTEXT*2 unchanged lines pass.
		let start = Math.max(0, k - CONTEXT);
		let end = k;
		let quiet = 0;
		while (end < ops.length && quiet <= CONTEXT * 2) {
			quiet = ops[end]!.kind === " " ? quiet + 1 : 0;
			end++;
		}
		end = Math.min(ops.length, end - Math.max(0, quiet - CONTEXT));
		let oldLine = 1;
		let newLine = 1;
		for (let x = 0; x < start; x++) {
			if (ops[x]!.kind !== "+") oldLine++;
			if (ops[x]!.kind !== "-") newLine++;
		}
		const body = ops.slice(start, end);
		const oldCount = body.filter((o) => o.kind !== "+").length;
		const newCount = body.filter((o) => o.kind !== "-").length;
		out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
		for (const o of body) out.push(`${o.kind}${o.line}`);
		k = end;
		start = end;
	}
	return out.join("\n");
}
