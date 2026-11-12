import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { standardKeymap, history, historyKeymap, indentMore, insertNewlineAndIndent } from "@codemirror/commands";
import { bracketMatching, indentUnit, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import type { PluginQuestionAnswerState, PluginQuestionEditorHandle, PluginQuestionEditorProps, PluginProblemEditorHandle, PluginProblemEditorProps } from "learnharness-plugin-api";
import { isReady, normalizeLineEndings, type CodingPayload, type CodingQuestionPayload } from "./contract.ts";
import { externalDiagnostics, supportsSyntaxDiagnostics, syntaxDiagnosticsExtension } from "./diagnostics.ts";
import { codingEditorRegistry, type CodingEditorDiagnostic } from "./editor-hook.ts";

export function findLanguage(name: string): LanguageDescription | null {
  return LanguageDescription.matchLanguageName(languages, name.trim(), false);
}

function codeFromAnswer(answer: PluginQuestionAnswerState): string {
  if (answer.status === "empty") return "";
  if (typeof answer.value !== "string") throw new Error("Coding answers must be strings.");
  return normalizeLineEndings(answer.value);
}

/** Every editor is owned by one host mount; no global editor or plugin draft store. */
function createCodeView(container: HTMLElement, language: string, code: string, active: boolean, onChange?: (code: string) => void) {
  const document = container.ownerDocument;
  const frame = document.createElement("div");
  frame.className = "lh-coding-question";
  const header = document.createElement("div");
  header.className = "lh-coding-question__header";
  const label = document.createElement("span");
  label.textContent = language;
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  const toolbar = document.createElement("span");
  toolbar.className = "lh-coding-question__toolbar";
  header.append(label, status, toolbar);
  frame.append(header);
  container.append(frame);

  let disposed = false;
  let applyingControlledUpdate = false;
  const editable = new Compartment();
  const languageSupport = new Compartment();
  const external = externalDiagnostics();
  const changeListeners = new Set<(code: string) => void>();
  const reservedKeys = new Set(["Tab", "Shift-Tab", "Enter", "Shift-Enter", "Mod-Enter", "Escape"]);
  const view = new EditorView({
    parent: frame,
    state: EditorState.create({
      doc: normalizeLineEndings(code),
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        bracketMatching(),
        EditorState.tabSize.of(4),
        indentUnit.of("    "),
        syntaxHighlighting(oneDarkHighlightStyle),
        EditorView.contentAttributes.of({ "aria-label": onChange ? "Code answer" : "Submitted code" }),
        editable.of([EditorState.readOnly.of(!active), EditorView.editable.of(active)]),
        languageSupport.of([]),
        ...(onChange ? [external.extension] : []),
        keymap.of([...standardKeymap, ...historyKeymap].filter(binding => ![binding.key, binding.mac, binding.win, binding.linux].some(key => key !== undefined && reservedKeys.has(key)))),
        EditorView.updateListener.of(update => {
          if (!update.docChanged || disposed) return;
          if (!applyingControlledUpdate && onChange) onChange(update.state.doc.toString());
          for (const listener of [...changeListeners]) {
            try { listener(update.state.doc.toString()); } catch (error) { console.error(error); }
          }
        }),
      ],
    }),
  });

  const languageDescription = findLanguage(language);
  if (!languageDescription) status.textContent = "Plain text";
  else {
    status.textContent = "Loading highlighting…";
    void languageDescription.load().then(support => {
      if (disposed) return;
      // Catalog support may include tag insertion, completion keymaps or other
      // editing helpers. Install only its language/parser, never those extras.
      view.dispatch({ effects: languageSupport.reconfigure([
        support.language,
        ...(onChange && supportsSyntaxDiagnostics(languageDescription.name) ? [syntaxDiagnosticsExtension()] : []),
      ]) });
      status.textContent = "";
    }).catch(() => {
      if (!disposed) status.textContent = "Plain text";
    });
  }

  return {
    view,
    toolbar,
    onCodeChange(listener: (code: string) => void) { changeListeners.add(listener); return () => { changeListeners.delete(listener); }; },
    setDiagnostics(extensionId: string, list: readonly CodingEditorDiagnostic[]) { if (!disposed) external.set(view, extensionId, list); },
    update(code: string, nextActive: boolean) {
      if (disposed) return;
      const nextCode = normalizeLineEndings(code);
      const codeChanged = view.state.doc.toString() !== nextCode;
      const activeChanged = active !== nextActive;
      if (!codeChanged && !activeChanged) return;
      applyingControlledUpdate = true;
      try {
        view.dispatch({
          ...(codeChanged ? { changes: { from: 0, to: view.state.doc.length, insert: nextCode } } : {}),
          ...(activeChanged ? { effects: editable.reconfigure([EditorState.readOnly.of(!nextActive), EditorView.editable.of(nextActive)]) } : {}),
        });
        active = nextActive;
      } finally { applyingControlledUpdate = false; }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      changeListeners.clear();
      view.destroy();
      frame.remove();
    },
  };
}

type CodeEditorProps = Pick<PluginQuestionEditorProps, "answer" | "active" | "signal" | "onChange"> & {
  readonly input: { payload: Pick<CodingPayload, "language" | "starterCode"> };
  readonly hook: { kind: "question" | "problem"; chatId: string; itemId: string };
};

function mountCodeEditor(container: HTMLElement, props: CodeEditorProps): PluginQuestionEditorHandle {
  let disposed = false;
  let active = props.active;
  const initialCode = props.answer.status === "empty" ? normalizeLineEndings(props.input.payload.starterCode ?? "") : codeFromAnswer(props.answer);
  const publish = (code: string) => {
    if (!disposed && !props.signal.aborted) props.onChange({ status: isReady(code) ? "ready" : "unready", value: code });
  };
  const editor = createCodeView(container, props.input.payload.language, initialCode, active, code => {
    if (active) publish(code);
  });
  let detach: (() => void) | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    props.signal.removeEventListener("abort", dispose);
    try { detach?.(); } finally { editor.dispose(); }
  };
  if (props.signal.aborted) dispose();
  else {
    props.signal.addEventListener("abort", dispose, { once: true });
    publish(initialCode);
    detach = codingEditorRegistry().attach({
      ...props.hook, language: props.input.payload.language, payload: props.input.payload,
      toolbar: editor.toolbar,
      isActive: () => !disposed && active,
      readCode: () => editor.view.state.doc.toString(),
      onCodeChange: listener => editor.onCodeChange(listener),
      setDiagnostics: (id, list) => editor.setDiagnostics(id, list),
    });
  }
  return {
    update(next) {
      if (disposed) return;
      active = next.active;
      editor.update(codeFromAnswer(next.answer), active);
    },
    focus() { if (!disposed && active) editor.view.focus(); },
    handleKeyDown(key) {
      if (disposed || !active || props.signal.aborted) return "pass";
      if (key === "Tab") { indentMore(editor.view); return "handled"; }
      if (key === "Enter" || key === "Shift+Enter") { insertNewlineAndIndent(editor.view); return "handled"; }
      return "pass";
    },
    dispose,
  };
}

export function mountAnswerEditor(container: HTMLElement, props: PluginQuestionEditorProps<CodingQuestionPayload>): PluginQuestionEditorHandle {
  return mountCodeEditor(container, { ...props, hook: { kind: "question", chatId: props.chatId, itemId: props.questionId } });
}

/** Adapt only the public controlled-state vocabulary; no fabricated question identity. */
export function mountSubmissionEditor(container: HTMLElement, props: PluginProblemEditorProps<CodingPayload>): PluginProblemEditorHandle {
  const handle = mountCodeEditor(container, {
    input: props.input, signal: props.signal, active: props.active,
    answer: props.submission, onChange: props.onChange,
    hook: { kind: "problem", chatId: props.chatId, itemId: props.problemId },
  });
  return {
    ...handle,
    update(next) { handle.update({ answer: next.submission, active: next.active }); },
  };
}

export function mountAnswered(container: HTMLElement, props: {
  readonly input: { payload: Pick<CodingPayload, "language"> };
  readonly signal: AbortSignal;
  readonly answer: string;
}): () => void {
  const editor = createCodeView(container, props.input.payload.language, props.answer, false);
  const dispose = () => {
    props.signal.removeEventListener("abort", dispose);
    editor.dispose();
  };
  if (props.signal.aborted) dispose();
  else props.signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
