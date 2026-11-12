import assert from "node:assert/strict";
import { test } from "node:test";
import { codingEditorRegistry, type AttachableEditor, type CodingEditorDiagnostic } from "../src/editor-hook.ts";

type FakeElement = { className: string; dataset: Record<string, string>; children: FakeElement[]; ownerDocument: { createElement(): FakeElement }; append(child: FakeElement): void; remove(): void; parent?: FakeElement };
function element(): FakeElement {
  const self: FakeElement = {
    className: "", dataset: {}, children: [],
    ownerDocument: { createElement: () => element() },
    append(child) { child.parent = self; self.children.push(child); },
    remove() { if (self.parent) self.parent.children = self.parent.children.filter(child => child !== self); },
  };
  return self;
}

function editor() {
  const toolbar = element();
  const diagnostics = new Map<string, readonly CodingEditorDiagnostic[]>();
  const listeners = new Set<(code: string) => void>();
  const surface: AttachableEditor = {
    kind: "problem", chatId: "chat", itemId: "p1", language: "python", payload: { language: "python" },
    toolbar: toolbar as unknown as HTMLElement,
    isActive: () => true, readCode: () => "code",
    onCodeChange: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    setDiagnostics: (id, list) => { diagnostics.set(id, list); },
  };
  return { surface, toolbar, diagnostics, listeners };
}

test("extensions mount on editors attached before and after registration", () => {
  const registry = codingEditorRegistry({});
  const early = editor();
  const detachEarly = registry.attach(early.surface);
  const seen: string[] = [];
  const unregister = registry.register({ id: "ws", mount(e) { seen.push(`${e.itemId}:${e.readCode()}`); e.setDiagnostics([{ line: 0, column: 0, endLine: 0, endColumn: 1, severity: "error", message: "x" }]); } });
  const late = editor();
  registry.attach(late.surface);
  assert.deepEqual(seen, ["p1:code", "p1:code"]);
  assert.equal(early.toolbar.children.length, 1);
  assert.equal(early.diagnostics.get("ws")?.length, 1);
  detachEarly();
  assert.equal(early.toolbar.children.length, 0);
  assert.deepEqual(early.diagnostics.get("ws"), []);
  unregister();
  assert.equal(late.toolbar.children.length, 0);
});

test("unmount aborts the extension signal and runs its cleanup", () => {
  const registry = codingEditorRegistry({});
  let signal: AbortSignal | undefined;
  let cleaned = false;
  registry.register({ id: "ws", mount(e) { signal = e.signal; return () => { cleaned = true; }; } });
  const detach = registry.attach(editor().surface);
  assert.equal(signal?.aborted, false);
  detach();
  assert.equal(signal?.aborted, true);
  assert.equal(cleaned, true);
});

test("duplicate extension ids are rejected", () => {
  const registry = codingEditorRegistry({});
  registry.register({ id: "ws", mount() {} });
  assert.throws(() => registry.register({ id: "ws", mount() {} }));
});
