import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { forceLinting, linter, type Diagnostic } from "@codemirror/lint";
import type { EditorState, Extension, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { CodingEditorDiagnostic } from "./editor-hook.ts";

const supportedLanguages = new Set([
  "Python", "JavaScript", "TypeScript", "C", "C++", "Java", "Rust", "Go", "JSON",
]);

/** Uses the catalog's canonical name so aliases inherit exactly the same policy. */
export function supportsSyntaxDiagnostics(languageName: string): boolean {
  return supportedLanguages.has(languageName);
}

/** Parser feedback only: never execute code, infer types, or reject an answer. */
export function syntaxDiagnostics(state: EditorState): Diagnostic[] {
  // Large documents may never be parsed in full while the viewport stays at
  // the top. Use the available tree, excluding recovery at its unfinished edge.
  const tree = syntaxTree(state);
  const complete = syntaxTreeAvailable(state);
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  tree.iterate({
    enter(node) {
      if (!node.type.isError || (!complete && node.to >= tree.length)) return;
      const key = `${node.from}:${node.to}`;
      if (seen.has(key)) return;
      seen.add(key);
      diagnostics.push({ from: node.from, to: node.to, severity: "error", message: "Syntax problem." });
    },
  });
  return diagnostics;
}

export function syntaxDiagnosticsExtension(): Extension {
  return linter(view => syntaxDiagnostics(view.state), {
    delay: 300,
    needsRefresh: update => syntaxTree(update.startState) !== syntaxTree(update.state),
  });
}

function offset(doc: Text, line: number, column: number): number {
  const lineNumber = Math.min(Math.max(Math.floor(line), 0) + 1, doc.lines);
  const info = doc.line(lineNumber);
  return Math.min(info.from + Math.max(Math.floor(column), 0), info.to);
}

/** Convert hook diagnostics to CodeMirror diagnostics against the current document. */
export function toCodeMirrorDiagnostics(doc: Text, list: readonly CodingEditorDiagnostic[]): Diagnostic[] {
  return list.map(d => {
    const from = offset(doc, d.line, d.column);
    const to = Math.max(from, offset(doc, d.endLine, d.endColumn));
    return { from, to, severity: d.severity, message: d.message, ...(d.source ? { source: d.source } : {}) };
  });
}

/** One lint source holding every extension's diagnostics, merged with other linters. */
export function externalDiagnostics(): { extension: Extension; set(view: EditorView, extensionId: string, list: readonly CodingEditorDiagnostic[]): void } {
  const byExtension = new Map<string, readonly CodingEditorDiagnostic[]>();
  return {
    extension: linter(view => toCodeMirrorDiagnostics(view.state.doc, [...byExtension.values()].flat()), { delay: 0 }),
    set(view, extensionId, list) {
      if (list.length) byExtension.set(extensionId, [...list]);
      else if (!byExtension.delete(extensionId)) return;
      forceLinting(view);
    },
  };
}
