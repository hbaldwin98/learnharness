/** The debrief screen: strengths, gaps, per-question results, and the hand-off
 * to a teaching session seeded with the gaps (E4 createSession). */
import type { PluginFrontendContext } from "learnharness-plugin-api";
import type { InterviewView } from "../contract.ts";
import { teachGapsPrompt } from "../debrief.ts";
import { el, errorText } from "./dom.ts";

export type DebriefStatus = "idle" | "writing" | "failed";

export function renderDebrief(parent: HTMLElement, ctx: PluginFrontendContext, signal: AbortSignal, opts: {
  view: InterviewView; status: DebriefStatus; error: string | null; onRetry: () => void; onShowTranscript: () => void;
}): void {
  const { view } = opts;
  const debrief = view.debrief;
  const root = el("div", "lh-iv-debrief");
  root.append(el("div", "lh-iv-label", "Debrief"), el("h1", "lh-iv-title", view.setup.topic),
    el("div", "lh-iv-muted", `${view.questions.length} questions planned · about ${view.setup.minutes} min`));

  if (!debrief) {
    if (opts.status === "failed") {
      const row = el("div", "lh-iv-row lh-iv-error");
      row.setAttribute("role", "alert");
      row.append(el("span", undefined, opts.error ?? "Couldn't write the debrief."));
      ctx.ui.mountButton(row, { label: "Try again", variant: "outline", size: "sm", onClick: opts.onRetry }, { signal });
      root.append(row);
    } else root.append(el("p", "lh-iv-muted", "Writing your debrief… this can take a minute."));
  } else {
    const grid = el("div", "lh-iv-debrief-grid");
    const card = (title: string, items: string[], cls: string) => {
      const section = el("section", `lh-iv-card ${cls}`);
      const list = el("ul");
      for (const item of items) list.append(el("li", undefined, item));
      section.append(el("h2", undefined, title), list);
      return section;
    };
    grid.append(card("Strong", debrief.strengths, "lh-iv-strong"), card("Gaps", debrief.gaps, "lh-iv-gaps"));
    const byQuestion = el("section", "lh-iv-by-question");
    byQuestion.append(el("h2", "lh-iv-label", "By question"));
    for (const p of debrief.perQuestion) {
      const i = view.questions.findIndex((q) => q.id === p.questionId);
      const row = el("div", "lh-iv-by-question-row");
      const full = p.keyPointsTotal > 0 && p.keyPointsHit === p.keyPointsTotal;
      row.append(el("span", undefined, i >= 0 ? `${i + 1} · ${view.questions[i]!.title}` : p.questionId),
        el("span", full ? "lh-iv-muted" : "lh-iv-warn", `${p.keyPointsHit} of ${p.keyPointsTotal} key points · ${p.summary}`));
      byQuestion.append(row);
    }
    root.append(grid, byQuestion);
  }

  const actions = el("div", "lh-iv-row lh-iv-end");
  const teachError = el("p", "lh-iv-error");
  teachError.setAttribute("role", "alert");
  ctx.ui.mountButton(actions, { label: "Read full transcript", variant: "outline", onClick: opts.onShowTranscript }, { signal });
  const teach = ctx.ui.mountButton(actions, {
    label: "Teach me the gaps",
    disabled: !debrief || debrief.gaps.length === 0,
    onClick: async () => {
      if (!debrief) return;
      teach.update({ disabled: true, label: "Starting…" });
      teachError.textContent = "";
      const prompt = teachGapsPrompt(view.setup.topic, debrief.gaps);
      try {
        await ctx.app.createSession({
          kind: "teaching",
          title: `Interview gaps: ${view.setup.topic}`.slice(0, 200),
          opening: { displayText: prompt, modelText: prompt },
          start: true,
          idempotencyKey: `teach-gaps-${view.id}`,
        }, { open: true });
      } catch (error) {
        if (signal.aborted) return;
        teachError.textContent = `Couldn't start the teaching session: ${errorText(error)}`;
        teach.update({ disabled: false, label: "Teach me the gaps" });
      }
    },
  }, { signal });
  root.append(actions, teachError);
  parent.append(root);
}
