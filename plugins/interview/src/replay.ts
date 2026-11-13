/** The replay harness (development only; not bundled): test the interviewer without
 * a mic. Timed chunks of finished speech pass through the SAME pause rule the Live
 * screen uses, and each resulting turn goes to a native Pi agent built from the
 * same instructions and end-turn tools the managed agent registers. */
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { InterviewListening, InterviewScript, InterviewSetup } from "./contract.ts";
import { interviewerInstructions, interviewerTools, type InterviewerState } from "./interviewer.ts";

export { turnsFromChunks } from "./pause.ts";

export interface ReplayFixture {
  name: string;
  setup: InterviewSetup;
  /** The Settings → Interview values to replay with. */
  listening: InterviewListening;
  /** Optional: a fixed script (deterministic, no author call). */
  script?: InterviewScript;
  chunks: { atMs: number; text: string }[];
}

export interface ReplayDecision {
  turn: string;
  tool: string | null;
  details: unknown;
}

export interface ReplayEngine {
  model: Model<any>;
  streamFn: StreamFn;
  thinkingLevel?: string;
}

/** Drive the interviewer over the turns, one run per turn ending at its first
 * successful tool (as `endRun` does in the managed agent). */
export async function runReplay(opts: { setup: InterviewSetup; script: InterviewScript; turns: readonly string[]; engine: ReplayEngine }): Promise<{ decisions: ReplayDecision[]; state: InterviewerState }> {
  const state: InterviewerState = { script: opts.script };
  const pluginTools = interviewerTools({
    read: () => state,
    setCurrent: (id) => { state.currentQuestionId = id; },
    end: () => { state.endedAt ??= new Date().toISOString(); },
  });
  const decisions: ReplayDecision[] = [];
  let messages: AgentMessage[] = [];
  for (const turn of opts.turns) {
    let ended = false;
    let turns = 0;
    const agent = new Agent({
      initialState: {
        systemPrompt: interviewerInstructions(opts.setup, opts.script),
        model: opts.engine.model,
        ...(opts.engine.thinkingLevel ? { thinkingLevel: opts.engine.thinkingLevel as never } : {}),
        messages,
        tools: pluginTools.map((t) => ({ name: t.name, label: t.name, description: t.description, parameters: t.parameters, execute: t.execute })),
      },
      streamFn: opts.engine.streamFn,
      finishTurn: () => { turns++; if (ended || turns >= 3) return { action: "end" }; },
    });
    agent.subscribe((event) => { if (event.type === "tool_execution_end" && !event.isError) ended = true; });
    const before = agent.state.messages.length;
    await agent.prompt({ role: "user", content: turn, timestamp: Date.now() });
    messages = [...agent.state.messages];
    const result = messages.slice(before).find((m) => m.role === "toolResult" && !m.isError);
    decisions.push({ turn, tool: result?.role === "toolResult" ? result.toolName : null, details: result?.role === "toolResult" ? result.details ?? null : null });
  }
  return { decisions, state };
}
