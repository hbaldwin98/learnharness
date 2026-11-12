import type { PluginFrontendContext } from "learnharness-plugin-api";
import { WIDTH_ATTRIBUTE, nextWidth, readWidth, writeWidth, type WidthStorage } from "./width.ts";

const WIDTH_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8l4 4-4 4"/><path d="M2 12h20"/><path d="M6 8l-4 4 4 4"/></svg>';

function storage(): WidthStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

/** Graphite is mostly CSS (styles.css). The frontend entry only owns the
 *  transcript width chip: a session top-bar action that cycles a root
 *  attribute the stylesheet maps to the transcript's max-width. */
export function activate(ctx: PluginFrontendContext): () => void {
  const root = document.documentElement;
  let width = readWidth(storage());
  root.setAttribute(WIDTH_ATTRIBUTE, width);
  const offAction = ctx.registerAction({
    id: "transcript-width",
    name: "Transcript width (760 / 960 / 1160 / 1360px)",
    icon: WIDTH_ICON,
    run() {
      width = nextWidth(width);
      writeWidth(storage(), width);
      root.setAttribute(WIDTH_ATTRIBUTE, width);
    },
  });
  const offPlacement = ctx.placeAction({ id: "transcript-width-top-bar", actionId: "transcript-width", location: "top-bar", sessions: ["teaching", "practice"] });
  return () => {
    offPlacement();
    offAction();
    root.removeAttribute(WIDTH_ATTRIBUTE);
  };
}
