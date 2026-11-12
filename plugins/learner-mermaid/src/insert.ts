import { insertSnippet } from "./fences.ts";

/** Where `snippet` landed after a host insert turned `before` into `after`.
 * The host inserts at the field's last caret (replacing any selection), so
 * `after` = before[0..s] + snippet + before[e..]; s is the first offset at or
 * before the common prefix where the snippet appears. */
export function locateInsertion(before: string, after: string, snippet: string): number {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  for (let s = Math.min(prefix, after.length - snippet.length); s >= Math.max(0, prefix - snippet.length); s--) {
    if (after.startsWith(snippet, s)) return s;
  }
  throw new Error("Could not locate the inserted diagram in the field.");
}

/** Re-pad an inserted snippet onto its own lines (the old fork's insertSnippet)
 * and return the full text plus the caret offset. */
export function placeSnippet(after: string, start: number, snippet: string, cursorInSnippet: number): { text: string; cursor: number } {
  const text = after.slice(0, start) + after.slice(start + snippet.length);
  return insertSnippet(text, start, start, snippet, cursorInSnippet);
}

/** Caret offset in a field element: textarea/input selection, or the text
 * length before the selection start in a contenteditable. */
export function caretOffset(element: Element | null): number | null {
  if (!element) return null;
  if (typeof HTMLTextAreaElement !== "undefined" && (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement)) return element.selectionStart;
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) return null;
  const before = element.ownerDocument.createRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}
