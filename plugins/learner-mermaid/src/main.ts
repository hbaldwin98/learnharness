import type { PluginFrontendContext, PluginLearnerField } from "learnharness-plugin-api";
import { isInsideMermaidFence, splitMermaidFences } from "./fences.ts";
import { DIAGRAM_TEMPLATES, fencedTemplate, type DiagramTemplate } from "./templates.ts";
import { caretOffset, locateInsertion, placeSnippet } from "./insert.ts";

export const PREVIEW_DEBOUNCE_MS = 400;
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M6 9v3a3 3 0 0 0 3 3h6"/></svg>';

/** Insert a template fence at the field's caret, on its own lines, caret on the type line. */
export function insertTemplate(field: PluginLearnerField, template: DiagramTemplate): void {
  const { snippet, cursor } = fencedTemplate(template);
  const before = field.read();
  field.insert(snippet);
  const after = field.read();
  const placed = placeSnippet(after, locateInsertion(before, after, snippet), snippet, cursor);
  if (placed.text !== after) field.write(placed.text);
  field.setCaret(placed.cursor);
}

/** Mermaid sources of a draft as host-renderable Markdown, or "" when none. */
export function previewMarkdown(text: string): string {
  return splitMermaidFences(text).filter(s => s.kind === "mermaid").map(s => "```mermaid\n" + s.content + "\n```").join("\n\n");
}

export function activate(ctx: PluginFrontendContext): () => void {
  const unregister = ctx.registerFieldAccessory({
    id: "diagram",
    label: "Insert a diagram",
    icon: ICON,
    fields: ["practice-answer", "question-answer", "thinking"],
    run(field, { anchor }) {
      const controller = new AbortController();
      field.signal.addEventListener("abort", () => controller.abort(), { once: true });
      ctx.ui.openMenu(anchor, {
        label: "Diagram starters", preferredSide: "up",
        items: DIAGRAM_TEMPLATES.map(template => ({ key: template.id, label: template.label, onSelect: () => { controller.abort(); insertTemplate(field, template); } })),
        onClose: () => controller.abort(),
      }, { signal: controller.signal });
    },
    preview: {
      mount(container, field) {
        const controller = new AbortController();
        const host = container.ownerDocument.createElement("div");
        host.className = "learner-mermaid-preview";
        host.dataset.testid = "diagram-preview";
        host.style.cssText = "max-height:16rem;overflow:auto;margin:0 0.625rem 0.25rem;padding:0.5rem;border:1px solid color-mix(in srgb, currentColor 15%, transparent);border-radius:0.375rem";
        let handle: { update(props: { text: string }): void; dispose(): void } | undefined;
        let shown = "";
        const render = (text: string) => {
          const markdown = previewMarkdown(text);
          if (markdown === shown) return;
          shown = markdown;
          if (!markdown) { handle?.dispose(); handle = undefined; host.remove(); return; }
          if (!host.isConnected) container.append(host);
          if (handle) handle.update({ text: markdown });
          else handle = ctx.ui.mountMarkdown(host, { text: markdown }, { signal: controller.signal });
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const off = field.onChange(text => {
          clearTimeout(timer);
          timer = setTimeout(() => render(text), PREVIEW_DEBOUNCE_MS);
        });
        render(field.read());
        return () => { clearTimeout(timer); off(); controller.abort(); handle?.dispose(); host.remove(); };
      },
    },
    onKeyDown(event, field) {
      // Inside a ```mermaid fence a bare Enter is a newline; Ctrl/Cmd+Enter still submits.
      if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing) return false;
      const target = typeof Element !== "undefined" && event.target instanceof Element ? event.target : null;
      const caret = caretOffset(target);
      if (caret === null) return false;
      const before = field.read();
      if (!isInsideMermaidFence(before, Math.min(caret, before.length))) return false;
      field.insert("\n");
      const after = field.read();
      field.setCaret(locateInsertion(before, after, "\n") + 1);
      return true;
    },
  });
  ctx.cleanup(unregister);
  return unregister;
}
