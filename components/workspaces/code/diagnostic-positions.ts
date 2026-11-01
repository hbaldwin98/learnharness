import type { Text } from "@codemirror/state";
import type { Diagnostic } from "@codemirror/lint";
import type { CodeDiagnostic } from "@/src/core";

/** LSP positions (0-based line, UTF-16 column) → editor offsets, clamped
 *  to the current text (plan step 4: diagnostics may trail the typing). */
export function toEditorDiagnostics(doc: Text, list: readonly CodeDiagnostic[]): Diagnostic[] {
	const offset = (line: number, column: number) => {
		if (line >= doc.lines) return doc.length;
		const l = doc.line(Math.max(0, line) + 1);
		return Math.min(l.to, l.from + Math.max(0, column));
	};
	return list.map((d) => {
		const from = offset(d.line, d.column);
		const to = Math.max(from, offset(d.endLine, d.endColumn));
		return { from, to, severity: d.severity, message: d.message, ...(d.source ? { source: d.source } : {}) };
	});
}
