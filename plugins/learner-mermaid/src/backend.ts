import type { PluginBackendContext } from "learnharness-plugin-api";
import { INSTRUCTIONS, PRACTICE_INSTRUCTIONS } from "./instructions.ts";

export function activate(ctx: PluginBackendContext): () => void {
  const disposers = [
    ctx.registerInstructions({ agents: ["prober", "teacher", "practice"], text: INSTRUCTIONS }),
    ctx.registerInstructions({ agents: ["practice"], text: PRACTICE_INSTRUCTIONS }),
  ];
  return () => disposers.splice(0).forEach(dispose => dispose());
}
