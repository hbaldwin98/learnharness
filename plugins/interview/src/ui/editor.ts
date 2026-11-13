/** The plugin's own CodeMirror editor for code questions (no dependency on the
 * coding-questions plugin). Contents are kept per question in this browser. */
import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentUnit, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";

const storageKey = (interviewId: string, questionId: string) => `lh:interview-code:${interviewId}:${questionId}`;

export function readSavedCode(interviewId: string, questionId: string): string | null {
  try { return localStorage.getItem(storageKey(interviewId, questionId)); } catch { return null; }
}
function saveCode(interviewId: string, questionId: string, code: string): void {
  try { localStorage.setItem(storageKey(interviewId, questionId), code); } catch { /* storage unavailable: the code still rides along */ }
}

export interface CodeEditorHandle {
  setEditable(editable: boolean): void;
  value(): string;
  destroy(): void;
}

export function mountCodeEditor(parent: HTMLElement, opts: {
  interviewId: string; questionId: string; language: string; initial: string; editable: boolean; onChange: (code: string) => void;
}): CodeEditorHandle {
  const editable = new Compartment();
  const language = new Compartment();
  const editableExt = (on: boolean) => [EditorState.readOnly.of(!on), EditorView.editable.of(on)];
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.initial,
      extensions: [
        lineNumbers(), history(), drawSelection(), bracketMatching(),
        EditorState.tabSize.of(4), indentUnit.of("    "),
        syntaxHighlighting(oneDarkHighlightStyle),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.contentAttributes.of({ "aria-label": "Code answer" }),
        editable.of(editableExt(opts.editable)),
        language.of([]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const code = update.state.doc.toString();
          saveCode(opts.interviewId, opts.questionId, code);
          opts.onChange(code);
        }),
      ],
    }),
  });
  let destroyed = false;
  const description = LanguageDescription.matchLanguageName(languages, opts.language.trim(), true);
  if (description) {
    void description.load().then((support) => {
      if (!destroyed) view.dispatch({ effects: language.reconfigure(support) });
    }).catch(() => { /* plain text */ });
  }
  return {
    setEditable: (on) => view.dispatch({ effects: editable.reconfigure(editableExt(on)) }),
    value: () => view.state.doc.toString(),
    destroy: () => { destroyed = true; view.destroy(); },
  };
}
