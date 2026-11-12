/**
 * Optional editor hook for other trusted plugins in the same window (for example
 * a Run button or language-server diagnostics). Plugins share no host service
 * registry, so the hook is a versioned, window-global registry keyed by a
 * well-known symbol. Extensions see active editors only; saved/answered code is
 * never offered. Without extensions, editors behave exactly as before.
 */
export const CODING_EDITOR_REGISTRY = Symbol.for("learnharness.coding-questions.editors.v1");

/** Zero-based line/column range (LSP style); clamped to the current document. */
export interface CodingEditorDiagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: "error" | "warning" | "info";
  message: string;
  source?: string;
}

export interface CodingEditorSurface {
  readonly kind: "question" | "problem";
  readonly chatId: string;
  /** Question or problem ID. */
  readonly itemId: string;
  readonly language: string;
  /** The saved question/problem payload (read-only). */
  readonly payload: unknown;
  /** An empty element in the editor header for extension controls. */
  readonly toolbar: HTMLElement;
  /** Aborted when this editor is disposed or the extension is unregistered. */
  readonly signal: AbortSignal;
  isActive(): boolean;
  readCode(): string;
  onCodeChange(listener: (code: string) => void): () => void;
  /** Replace this extension's diagnostics (other sources are kept). */
  setDiagnostics(diagnostics: readonly CodingEditorDiagnostic[]): void;
}

export interface CodingEditorExtension {
  readonly id: string;
  mount(editor: CodingEditorSurface): void | (() => void);
}

export interface CodingEditorRegistry {
  readonly version: 1;
  register(extension: CodingEditorExtension): () => void;
  /** Host side: attach every extension to a new editor, now and as they register. */
  attach(editor: AttachableEditor): () => void;
}

export type AttachableEditor = Omit<CodingEditorSurface, "toolbar" | "signal" | "setDiagnostics"> & {
  readonly toolbar: HTMLElement;
  setDiagnostics(extensionId: string, diagnostics: readonly CodingEditorDiagnostic[]): void;
};

export function codingEditorRegistry(scope: Record<PropertyKey, unknown> = globalThis as Record<PropertyKey, unknown>): CodingEditorRegistry {
  const existing = scope[CODING_EDITOR_REGISTRY] as CodingEditorRegistry | undefined;
  if (existing?.version === 1) return existing;
  const extensions = new Set<CodingEditorExtension>();
  const editors = new Set<AttachableEditor>();
  const mounts = new Map<string, () => void>();
  const keyOf = new WeakMap<AttachableEditor, number>();
  let next = 0;
  const key = (editor: AttachableEditor, extension: CodingEditorExtension) => `${keyOf.get(editor)}\0${extension.id}`;
  const mount = (editor: AttachableEditor, extension: CodingEditorExtension) => {
    const controller = new AbortController();
    const slot = editor.toolbar.ownerDocument.createElement("span");
    slot.className = "lh-coding-question__extension";
    slot.dataset.extension = extension.id;
    editor.toolbar.append(slot);
    let cleanup: void | (() => void);
    try {
      cleanup = extension.mount({
        kind: editor.kind, chatId: editor.chatId, itemId: editor.itemId, language: editor.language, payload: editor.payload,
        toolbar: slot, signal: controller.signal,
        isActive: () => editor.isActive(), readCode: () => editor.readCode(),
        onCodeChange: listener => editor.onCodeChange(listener),
        setDiagnostics: list => { if (!controller.signal.aborted) editor.setDiagnostics(extension.id, list); },
      });
    } catch (error) { console.error(`Coding editor extension ${extension.id} failed`, error); }
    mounts.set(key(editor, extension), () => {
      controller.abort();
      try { cleanup?.(); } catch (error) { console.error(error); }
      editor.setDiagnostics(extension.id, []);
      slot.remove();
    });
  };
  const unmount = (editor: AttachableEditor, extension: CodingEditorExtension) => {
    const k = key(editor, extension);
    mounts.get(k)?.();
    mounts.delete(k);
  };
  const registry: CodingEditorRegistry = {
    version: 1,
    register(extension) {
      if (!extension || typeof extension.id !== "string" || typeof extension.mount !== "function") throw new Error("Coding editor extension must have an id and mount()");
      if ([...extensions].some(other => other.id === extension.id)) throw new Error(`Duplicate coding editor extension ${extension.id}`);
      extensions.add(extension);
      for (const editor of editors) mount(editor, extension);
      return () => {
        if (!extensions.delete(extension)) return;
        for (const editor of editors) unmount(editor, extension);
      };
    },
    attach(editor) {
      keyOf.set(editor, next++);
      editors.add(editor);
      for (const extension of extensions) mount(editor, extension);
      return () => {
        if (!editors.delete(editor)) return;
        for (const extension of extensions) unmount(editor, extension);
      };
    },
  };
  scope[CODING_EDITOR_REGISTRY] = registry;
  return registry;
}
