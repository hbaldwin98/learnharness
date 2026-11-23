import type { PluginFrontendContext } from "learnharness-plugin-api";

/** Graphite is all CSS (styles.css); the frontend entry has nothing to run. */
export function activate(_ctx: PluginFrontendContext): () => void {
  return () => {};
}
