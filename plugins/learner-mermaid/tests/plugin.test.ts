import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginBackendContext, PluginFieldAccessory, PluginFrontendContext, PluginInstructions, PluginLearnerField } from "learnharness-plugin-api";
import { activate as activateBackend } from "../src/backend.ts";
import { activate, insertTemplate, previewMarkdown } from "../src/main.ts";
import { locateInsertion, placeSnippet } from "../src/insert.ts";
import { DIAGRAM_TEMPLATES, fencedTemplate } from "../src/templates.ts";
import { splitMermaidFences } from "../src/fences.ts";

/** A field whose insert replaces [start,end) like the host's live editor. */
function field(text: string, start = text.length, end = start) {
  let value = text, caret = -1;
  const handle = {
    kind: "practice-answer", sessionId: "s", signal: new AbortController().signal,
    read: () => value, write: (next: string) => { value = next; },
    insert: (snippet: string) => { value = value.slice(0, start) + snippet + value.slice(end); },
    setCaret: (offset: number) => { caret = offset; }, onChange: () => () => {},
  } as unknown as PluginLearnerField;
  return { handle, get value() { return value; }, get caret() { return caret; } };
}

describe("diagram starter templates", () => {
  it("each inserts as one closed mermaid fence with the caret on the type line", () => {
    const keywords = /^(flowchart|sequenceDiagram|classDiagram|stateDiagram-v2|erDiagram|C4Context|C4Container)\b/;
    for (const template of DIAGRAM_TEMPLATES) {
      const { snippet, cursor } = fencedTemplate(template);
      const segments = splitMermaidFences(snippet);
      assert.equal(segments.length, 1, template.id);
      assert.equal(segments[0]!.kind, "mermaid", template.id);
      assert.match(segments[0]!.content, keywords, template.id);
      assert.ok(snippet.endsWith("\n```"), template.id);
      assert.equal(snippet[cursor], "\n", `${template.id}: caret at the end of the type line`);
    }
  });
});

describe("insertTemplate", () => {
  const template = DIAGRAM_TEMPLATES[0]!;
  const { snippet, cursor } = fencedTemplate(template);
  it("pads the fence onto its own lines mid-text and leaves the caret on the type line", () => {
    const f = field("before after", 6);
    insertTemplate(f.handle, template);
    assert.equal(f.value, `before\n${snippet}\n after`);
    assert.equal(f.caret, 7 + cursor);
  });
  it("needs no padding at line boundaries and replaces a selection", () => {
    const f = field("a\nXX\nb", 2, 4);
    insertTemplate(f.handle, template);
    assert.equal(f.value, `a\n${snippet}\nb`);
    assert.equal(f.caret, 2 + cursor);
  });
  it("into an empty field is just the fence", () => {
    const f = field("");
    insertTemplate(f.handle, template);
    assert.equal(f.value, snippet);
  });
});

describe("insertion helpers", () => {
  it("locates an insert even when the snippet repeats the text before it", () => {
    assert.equal(locateInsertion("``", "`````mermaid", "```mermaid"), 2);
    assert.equal(locateInsertion("ab", "a\nb", "\n"), 1);
  });
  it("placeSnippet pads like insertSnippet", () => {
    assert.deepEqual(placeSnippet("xSy", 1, "S", 1), { text: "x\nS\ny", cursor: 3 });
  });
});

describe("previewMarkdown", () => {
  it("is empty without a fence and re-fences each chart, including an unclosed one", () => {
    assert.equal(previewMarkdown("plain"), "");
    assert.equal(previewMarkdown("a\n```mermaid\nflowchart LR\n```\nb\n```mermaid\nerDiagram"),
      "```mermaid\nflowchart LR\n```\n\n```mermaid\nerDiagram\n```");
  });
});

describe("registrations", () => {
  it("adds the diagram accessory to the fields the old fork covered", () => {
    const accessories: PluginFieldAccessory[] = [];
    const ctx = { cleanup() {}, registerFieldAccessory(a: PluginFieldAccessory) { accessories.push(a); return () => {}; } } as unknown as PluginFrontendContext;
    activate(ctx);
    assert.equal(accessories.length, 1);
    assert.deepEqual(accessories[0]!.fields, ["practice-answer", "question-answer", "thinking"]);
    assert.ok(accessories[0]!.preview && accessories[0]!.onKeyDown);
  });
  it("Enter outside a fence or with a modifier is left to the host", () => {
    let accessory!: PluginFieldAccessory;
    activate({ cleanup() {}, registerFieldAccessory(a: PluginFieldAccessory) { accessory = a; return () => {}; } } as unknown as PluginFrontendContext);
    const f = field("```mermaid\nflowchart LR\n```");
    assert.equal(accessory.onKeyDown!({ key: "Enter", ctrlKey: true } as KeyboardEvent, f.handle), false);
    assert.equal(accessory.onKeyDown!({ key: "a" } as KeyboardEvent, f.handle), false);
  });
  it("registers Mermaid guidance for every lesson role and judging guidance for practice only", () => {
    const registered: PluginInstructions[] = [];
    const dispose = activateBackend({ registerInstructions(c: PluginInstructions) { registered.push(c); return () => {}; } } as unknown as PluginBackendContext);
    assert.deepEqual(registered.map(r => r.agents), [["prober", "teacher", "practice"], ["practice"]]);
    assert.match(registered[0]!.text, /sequenceDiagram/);
    assert.match(registered[0]!.text, /about eight elements/);
    assert.match(registered[1]!.text, /Judge structure, not text/);
    dispose();
  });
});
