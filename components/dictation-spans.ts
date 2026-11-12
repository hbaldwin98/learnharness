/**
 * Live dictated text in its target fields (owner, 2026-10-27: committed
 * text lands in the box as it streams; Esc removes this run's text).
 *
 * A run owns the text it inserted — one segment per target it wrote to (a
 * question claiming the target mid-run opens a new segment there). Each
 * update rewrites the segment in place, found at its recorded offset or,
 * if the learner typed before it, by searching back from the end. A
 * segment the learner edited over is never fought: only text that is new
 * to the run is added, as a fresh segment at the end.
 */

export type DictationTarget = {
	read: () => string;
	write: (value: string) => void;
};

type Segment = {
	target: DictationTarget;
	/** Offset of `text` in the target; -1 once lost. */
	start: number;
	text: string;
	/** Where `text` starts in the run's whole text. */
	from: number;
	/** We inserted a separating space before it. */
	separated: boolean;
};

export class DictationSpans {
	private segments: Segment[] = [];

	constructor(private readonly current: () => DictationTarget) {}

	get empty(): boolean {
		return this.segments.every((s) => s.text === "");
	}

	/** Make the run's text (everything it has said so far) read `text`. */
	set(text: string): void {
		const target = this.current();
		let seg = this.segments.at(-1);
		if (seg && seg.target !== target) seg = undefined;
		let placed = this.placedBefore(seg);
		if (!seg) {
			// A new segment owns its own separator: skip the run's whitespace.
			while (placed < text.length && /\s/.test(text[placed]!)) placed++;
			if (placed >= text.length) return;
			seg = this.open(target, placed);
		}
		this.replace(seg, text.length > seg.from ? text.slice(seg.from) : "");
	}

	/** Take this run's text back out of every target (Esc). */
	remove(): void {
		for (const seg of [...this.segments].reverse()) {
			const cur = seg.target.read();
			const at = this.locate(seg, cur);
			if (at < 0 || !seg.text) continue;
			const start = seg.separated && cur[at - 1] === " " ? at - 1 : at;
			seg.target.write(cur.slice(0, start) + cur.slice(at + seg.text.length));
		}
		this.segments = [];
	}

	private placedBefore(seg: Segment | undefined): number {
		const prior = seg ? this.segments.slice(0, -1) : this.segments;
		const last = prior.at(-1);
		return last ? last.from + last.text.length : 0;
	}

	private open(target: DictationTarget, from: number): Segment {
		const cur = target.read();
		const base = cur.replace(/\s+$/, "");
		const separated = base.length > 0;
		const head = separated ? `${base} ` : base;
		if (head !== cur) target.write(head);
		const seg = { target, start: head.length, text: "", from, separated };
		this.segments.push(seg);
		return seg;
	}

	private locate(seg: Segment, cur: string): number {
		if (seg.start >= 0 && seg.start <= cur.length && cur.slice(seg.start, seg.start + seg.text.length) === seg.text) return seg.start;
		return seg.text ? cur.lastIndexOf(seg.text) : -1;
	}

	private replace(seg: Segment, next: string): void {
		if (next === seg.text) return;
		const cur = seg.target.read();
		const at = this.locate(seg, cur);
		if (at >= 0) {
			seg.target.write(cur.slice(0, at) + next + cur.slice(at + seg.text.length));
			seg.start = at;
			seg.text = next;
			return;
		}
		// Lost under the learner's edits: keep their text, add only what is new.
		seg.start = -1;
		if (!next.startsWith(seg.text)) return;
		const rest = next.slice(seg.text.length);
		const lead = rest.length - rest.trimStart().length;
		if (lead === rest.length) return;
		const fresh = this.open(seg.target, seg.from + seg.text.length + lead);
		this.replace(fresh, rest.slice(lead));
	}
}
