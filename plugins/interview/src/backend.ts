import { randomUUID } from "node:crypto";
import type { PluginBackendContext, PluginModelSpec } from "learnharness-plugin-api";
import { authorInterview } from "./author.ts";
import { CHANGED_TOPIC, INTERVIEW_OPENING, parseSetup, type InterviewDebrief, type InterviewSettings } from "./contract.ts";
import { writeDebrief } from "./debrief.ts";
import { interviewerInstructions, interviewerTools } from "./interviewer.ts";
import { lowestThinkingLevel, parseSettingsPatch, resolveListening } from "./settings.ts";
import { createStore, type InterviewRecord } from "./store.ts";
import type { Complete } from "./submit.ts";
import { toInterviewView, toSummary } from "./view-model.ts";

const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function idOf(input: unknown): string {
  const id = object(input).id;
  if (typeof id !== "string" || !id) throw new Error("Expected an interview id");
  return id;
}

export function activate(ctx: PluginBackendContext): () => void {
  const store = createStore(ctx.dataDirectory);
  const unregister: (() => void)[] = [];
  const definitionId = (record: InterviewRecord) => `interviewer-${record.id}`;
  const emitChanged = (id: string) => { if (!ctx.signal.aborted) ctx.events.emit(CHANGED_TOPIC, { id }); };

  const registerInterviewer = (record: InterviewRecord) => {
    const id = record.id;
    const tools = interviewerTools({
      read: () => store.get(id),
      setCurrent: (questionId) => { store.mutate(id, (r) => ({ ...r, currentQuestionId: questionId })); },
      end: () => { store.mutate(id, (r) => (r.endedAt ? r : { ...r, endedAt: new Date().toISOString() })); },
    });
    unregister.push(ctx.agents.register({
      id: definitionId(record),
      instructions: interviewerInstructions(record.setup, record.script),
      model: record.interviewerModel as PluginModelSpec,
      tools,
      // One tool ends the turn; the extra turns let it correct an invalid call.
      maxTurns: 3,
    }));
  };
  for (const record of store.list()) {
    try { registerInterviewer(record); } catch (error) { console.error(`[interview ${record.id}] interviewer unavailable`, error); }
  }

  // One observation per conversation: notify the view when the run status or the
  // committed transcript changes (not on every streamed partial).
  const watched = new Map<string, () => void>();
  const watch = (record: InterviewRecord) => {
    if (watched.has(record.id)) return;
    let last = "";
    watched.set(record.id, ctx.agents.subscribe(record.agentSessionId, (snapshot) => {
      const key = `${snapshot.status}:${snapshot.messages.length}`;
      if (key === last) return;
      last = key;
      emitChanged(record.id);
    }));
  };

  const catalog = () => ctx.inference.catalog();
  const strongModel = async (): Promise<PluginModelSpec> => {
    const slot = (await catalog()).slots.strong;
    if (!slot) throw new Error("Set up a strong model first (Settings → Models).");
    return { ...slot.model, ...(slot.thinkingLevel ? { thinkingLevel: slot.thinkingLevel } : {}) };
  };
  const interviewerModel = async (settings: InterviewSettings): Promise<PluginModelSpec> => {
    const current = await catalog();
    const choice = settings.interviewerModel ?? current.slots.cheap?.model;
    if (!choice) throw new Error("Set up a cheap model (Settings → Models) or pick an interviewer model in Settings → Interview.");
    const entry = current.models.find((m) => m.provider === choice.provider && m.id === choice.id);
    if (!entry) throw new Error(`The interviewer model ${choice.provider}:${choice.id} is not available.`);
    const level = entry.reasoning ? lowestThinkingLevel(entry.supportedLevels) : undefined;
    return { provider: choice.provider, id: choice.id, ...(level ? { thinkingLevel: level } : {}) };
  };
  const completeWith = (model: PluginModelSpec): Complete => (context) =>
    ctx.inference.complete({ model, context, purpose: "user", signal: ctx.signal });

  const record = (id: string): InterviewRecord => {
    const found = store.get(id);
    if (!found) throw new Error("Unknown interview");
    return found;
  };
  const agentOf = (r: InterviewRecord) => {
    try { return ctx.agents.get(r.agentSessionId); } catch { return null; }
  };
  const view = (id: string) => {
    const r = record(id);
    return toInterviewView(r, resolveListening(store.readSettings()), agentOf(r));
  };

  unregister.push(ctx.handle("settings.get", () => store.readSettings()));
  unregister.push(ctx.handle("settings.set", (input) => {
    const parsed = parseSettingsPatch(input, store.readSettings());
    if (!parsed.ok) throw new Error(parsed.error);
    store.writeSettings(parsed.value);
    return parsed.value;
  }));
  unregister.push(ctx.handle("list", () => store.list().map(toSummary)));
  unregister.push(ctx.handle("get", (input) => view(idOf(input))));

  unregister.push(ctx.handle("start", async (input) => {
    const parsed = parseSetup(input);
    if (!parsed.ok) throw new Error(parsed.error);
    const { setup } = parsed;
    const strong = await strongModel();
    const interviewer = await interviewerModel(store.readSettings());
    let script;
    try {
      script = await authorInterview(setup, completeWith(strong));
    } catch (error) {
      console.error("[interview] author failed —", error instanceof Error ? error.message : String(error));
      throw new Error("Couldn't write the interview. Try again.");
    }
    if (ctx.signal.aborted) throw new Error("The Interview plugin was disabled.");
    const now = new Date().toISOString();
    const draft = { version: 1, id: randomUUID(), setup, script, interviewerModel: interviewer, agentSessionId: "", createdAt: now, updatedAt: now };
    registerInterviewer(draft);
    const session = ctx.agents.create(definitionId(draft));
    const created: InterviewRecord = { ...draft, agentSessionId: session.id };
    store.put(created);
    watch(created);
    await ctx.agents.send(session.id, INTERVIEW_OPENING, { requestId: "opening", purpose: "user" });
    return { id: created.id };
  }));

  unregister.push(ctx.handle("send", async (input) => {
    const value = object(input);
    const r = record(idOf(value));
    if (r.endedAt) throw new Error("The interview has ended.");
    if (typeof value.text !== "string" || !value.text.trim()) throw new Error("Nothing to send");
    if (typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId)) throw new Error("Invalid request id");
    watch(r);
    await ctx.agents.send(r.agentSessionId, value.text, { requestId: value.requestId, purpose: "user" });
    return view(r.id);
  }));

  unregister.push(ctx.handle("end", (input) => {
    const id = idOf(input);
    const r = record(id);
    try { ctx.agents.abort(r.agentSessionId); } catch { /* not running */ }
    store.mutate(id, (x) => (x.endedAt ? x : { ...x, endedAt: new Date().toISOString() }));
    emitChanged(id);
    return view(id);
  }));

  // The debrief is written once and stored; concurrent requests share the run.
  const inFlight = new Map<string, Promise<InterviewDebrief>>();
  unregister.push(ctx.handle("debrief", (input) => {
    const id = idOf(input);
    const r = record(id);
    if (r.debrief) return r.debrief;
    if (!r.endedAt) throw new Error("The interview hasn't ended yet.");
    const running = inFlight.get(id);
    if (running) return running;
    const run = (async () => {
      const agent = agentOf(r);
      if (!agent) throw new Error("The interview transcript is unavailable.");
      let debrief: InterviewDebrief;
      try {
        debrief = await writeDebrief(r.script, agent.messages, completeWith(await strongModel()));
      } catch (error) {
        console.error(`[interview ${id}] debrief failed —`, error instanceof Error ? error.message : String(error));
        throw new Error("Couldn't write the debrief. Try again.");
      }
      if (ctx.signal.aborted) throw new Error("The Interview plugin was disabled.");
      store.mutate(id, (x) => ({ ...x, debrief }));
      emitChanged(id);
      return debrief;
    })().finally(() => inFlight.delete(id));
    inFlight.set(id, run);
    return run;
  }));

  return () => {
    for (const stop of watched.values()) stop();
    for (const stop of unregister.reverse()) stop();
  };
}
