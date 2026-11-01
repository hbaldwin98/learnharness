/**
 * The agent's annotations in the editor (practice workspaces, plan step 7):
 * the annotated lines get a faint highlight and the note sits in a block
 * under the last line, with a dismiss button. The server re-anchors notes
 * on each save; between saves the decorations map through edits here.
 */

import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

export interface EditorAnnotation {
	id: string;
	line: number;
	endLine: number;
	note: string;
}

export const setAnnotations = StateEffect.define<{ list: EditorAnnotation[]; onDismiss?: (id: string) => void }>();

class NoteWidget extends WidgetType {
	constructor(
		readonly id: string,
		readonly note: string,
		readonly onDismiss?: (id: string) => void,
	) {
		super();
	}
	eq(other: NoteWidget): boolean {
		return other.id === this.id && other.note === this.note;
	}
	toDOM(): HTMLElement {
		const box = document.createElement("div");
		box.className = "cm-annotation-note";
		box.setAttribute("data-testid", "annotation-note");
		const label = document.createElement("span");
		label.className = "cm-annotation-label";
		label.textContent = "Agent";
		const text = document.createElement("span");
		text.textContent = this.note;
		box.append(label, text);
		if (this.onDismiss) {
			const close = document.createElement("button");
			close.type = "button";
			close.className = "cm-annotation-dismiss";
			close.setAttribute("aria-label", "Dismiss the note");
			close.textContent = "×";
			close.onmousedown = (e) => e.preventDefault();
			close.onclick = () => this.onDismiss?.(this.id);
			box.append(close);
		}
		return box;
	}
	ignoreEvent(): boolean {
		return false;
	}
}

function build(state: EditorState, list: readonly EditorAnnotation[], onDismiss?: (id: string) => void): DecorationSet {
	const ranges = [];
	const lines = state.doc.lines;
	for (const a of list) {
		const first = Math.min(Math.max(1, a.line), lines);
		const last = Math.min(Math.max(first, a.endLine), lines);
		for (let n = first; n <= last; n++) ranges.push(Decoration.line({ class: "cm-annotated-line" }).range(state.doc.line(n).from));
		ranges.push(
			Decoration.widget({ widget: new NoteWidget(a.id, a.note, onDismiss), block: true, side: 1 }).range(state.doc.line(last).to),
		);
	}
	return Decoration.set(ranges, true);
}

export const annotationField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		let next = deco.map(tr.changes);
		for (const e of tr.effects) if (e.is(setAnnotations)) next = build(tr.state, e.value.list, e.value.onDismiss);
		return next;
	},
	provide: (f) => EditorView.decorations.from(f),
});

export const annotationTheme = EditorView.theme({
	".cm-annotated-line": { backgroundColor: "color-mix(in oklab, #f59e0b 10%, transparent)" },
	".cm-annotation-note": {
		display: "flex",
		gap: "8px",
		alignItems: "baseline",
		margin: "2px 8px 4px 0",
		padding: "4px 8px",
		borderLeft: "3px solid #f59e0b",
		borderRadius: "4px",
		backgroundColor: "var(--card)",
		color: "var(--foreground)",
		fontFamily: "var(--font-sans, sans-serif)",
		fontSize: "12.5px",
		lineHeight: "1.45",
		whiteSpace: "pre-wrap",
	},
	".cm-annotation-label": { color: "#f59e0b", fontFamily: "var(--font-mono)", fontSize: "11px", textTransform: "uppercase" },
	".cm-annotation-dismiss": { marginLeft: "auto", color: "var(--muted-foreground)", cursor: "pointer", background: "none", border: "none" },
});
