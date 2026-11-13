/** Tiny DOM helpers: safe text only, never model HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function requestId(): string {
  return crypto.randomUUID();
}
