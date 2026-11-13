/** Projections from the backend record + agent conversation to what the frontend
 * may see. Pure: key points, probes, red flags and correct choices never pass. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { InterviewEntry, InterviewListening, InterviewRunStatus, InterviewSummary, InterviewToolDetails, InterviewView } from "./contract.ts";
import { userText } from "./debrief.ts";
import type { InterviewRecord } from "./store.ts";

/** The transcript, flattened from the conversation; consecutive quiet turns
 * collapse into one run. */
export function interviewEntries(messages: readonly AgentMessage[]): InterviewEntry[] {
  const out: InterviewEntry[] = [];
  messages.forEach((m, i) => {
    const id = String(i);
    if (m.role === "user") {
      const text = userText(m);
      if (text.trim()) out.push({ kind: "you", id, text });
      return;
    }
    if (m.role !== "toolResult" || m.isError) return;
    const d = m.details as InterviewToolDetails | undefined;
    const last = out[out.length - 1];
    switch (d?.kind) {
      case "quiet":
        if (last?.kind === "quiet") last.count++;
        else out.push({ kind: "quiet", id, count: 1 });
        break;
      case "interject": out.push({ kind: "said", id, label: "Interjected", text: d.text, accent: true }); break;
      case "probe": out.push({ kind: "said", id, label: "Follow-up", text: d.text, accent: true }); break;
      case "advance": out.push({ kind: "said", id, label: d.title, text: d.text, accent: false }); break;
      case "wrap_up": out.push({ kind: "said", id, label: "Wrapping up", text: d.text, accent: false }); break;
      case "choice": out.push({ kind: "choice", id, questionId: d.questionId, prompt: d.prompt, choices: [...d.choices] }); break;
      case "code": out.push({ kind: "code", id, questionId: d.questionId, prompt: d.prompt, starterCode: { ...d.starterCode } }); break;
    }
  });
  return out;
}

export function toInterviewView(
  record: InterviewRecord,
  listening: InterviewListening,
  agent: { messages: readonly AgentMessage[]; status: InterviewRunStatus; error?: string } | null,
): InterviewView {
  return {
    id: record.id,
    setup: { ...record.setup },
    listening,
    questions: record.script.questions.map((q) => ({ id: q.id, title: q.title, format: q.format })),
    ...(record.currentQuestionId ? { currentQuestionId: record.currentQuestionId } : {}),
    ...(record.endedAt ? { endedAt: record.endedAt } : {}),
    status: agent?.status ?? "error",
    ...(agent?.error ? { error: agent.error } : agent ? {} : { error: "The interviewer conversation is unavailable." }),
    entries: agent ? interviewEntries(agent.messages) : [],
    ...(record.debrief ? { debrief: record.debrief } : {}),
  };
}

export function toSummary(record: InterviewRecord): InterviewSummary {
  return {
    id: record.id, topic: record.setup.topic, style: record.setup.style, minutes: record.setup.minutes,
    createdAt: record.createdAt, ended: Boolean(record.endedAt), hasDebrief: Boolean(record.debrief),
  };
}
