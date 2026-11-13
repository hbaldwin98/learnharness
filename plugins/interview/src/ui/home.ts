/** The start screen (topic, style, length) and the list of past interviews. */
import type { PluginFrontendContext } from "learnharness-plugin-api";
import { INTERVIEW_LENGTHS, type InterviewStyle, type InterviewSummary } from "../contract.ts";
import { el, errorText } from "./dom.ts";

const STYLES: { value: InterviewStyle; label: string }[] = [
  { value: "narration", label: "Narration" },
  { value: "coding", label: "Coding" },
  { value: "system-design", label: "System design" },
];

function chips<T>(label: string, options: { value: T; label: string }[], initial: T, onPick: (value: T) => void) {
  const group = el("div", "lh-iv-chips");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  const buttons = options.map((o) => {
    const b = el("button", "lh-iv-chip", o.label);
    b.type = "button";
    b.setAttribute("aria-pressed", String(o.value === initial));
    b.addEventListener("click", () => {
      for (const x of buttons) x.setAttribute("aria-pressed", String(x === b));
      onPick(o.value);
    });
    group.append(b);
    return b;
  });
  return { group, setDisabled: (d: boolean) => buttons.forEach((b) => { b.disabled = d; }) };
}

export function mountHome(container: HTMLElement, ctx: PluginFrontendContext, signal: AbortSignal, open: (id: string) => void): void {
  const root = el("div", "lh-iv lh-iv-home");
  const form = el("section", "lh-iv-start");
  form.append(el("h1", "lh-iv-title", "Interview me"), el("p", "lh-iv-muted", "Pick a topic. The interview is written for you, then you answer out loud."));
  const topic = el("textarea", "lh-iv-topic");
  topic.rows = 3;
  topic.placeholder = "What should the interview be about?";
  topic.setAttribute("aria-label", "Interview topic");
  let style: InterviewStyle = "narration";
  let minutes = 15;
  const styleChips = chips("Interview style", STYLES, style, (v) => { style = v; });
  const lengthChips = chips("Length", INTERVIEW_LENGTHS.map((m) => ({ value: m, label: `~${m} min` })), minutes, (v) => { minutes = v; });
  const status = el("p", "lh-iv-muted");
  status.setAttribute("role", "status");
  const actions = el("div", "lh-iv-row");
  form.append(topic, styleChips.group, lengthChips.group, actions, status);

  let busy = false;
  const start = async () => {
    if (busy || !topic.value.trim()) return;
    busy = true;
    sync();
    status.textContent = "Writing your interview… this can take a minute.";
    status.classList.remove("lh-iv-error");
    try {
      const { id } = await ctx.call<{ id: string }>("start", { topic: topic.value, style, minutes });
      if (!signal.aborted) open(id);
    } catch (error) {
      if (signal.aborted) return;
      status.textContent = errorText(error);
      status.classList.add("lh-iv-error");
      busy = false;
      sync();
    }
  };
  const button = ctx.ui.mountButton(actions, { label: "Start interview", onClick: start, disabled: true }, { signal });
  const sync = () => {
    topic.disabled = busy;
    styleChips.setDisabled(busy);
    lengthChips.setDisabled(busy);
    button.update({ disabled: busy || !topic.value.trim() });
  };
  topic.addEventListener("input", sync);
  topic.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void start(); }
  });

  const list = el("section", "lh-iv-list");
  root.append(form, list);
  container.append(root);

  const loadList = async () => {
    let items: InterviewSummary[];
    try { items = await ctx.call<InterviewSummary[]>("list"); } catch (error) {
      if (!signal.aborted) list.replaceChildren(el("p", "lh-iv-error", errorText(error)));
      return;
    }
    if (signal.aborted) return;
    list.replaceChildren();
    if (!items.length) return;
    list.append(el("h2", "lh-iv-label", "Your interviews"));
    for (const item of items) {
      const row = el("button", "lh-iv-list-row");
      row.type = "button";
      const label = STYLES.find((s) => s.value === item.style)?.label ?? item.style;
      const state = item.hasDebrief ? "debriefed" : item.ended ? "ended" : "in progress";
      row.append(el("span", "lh-iv-list-topic", item.topic), el("span", "lh-iv-muted", `${label} · ~${item.minutes} min · ${new Date(item.createdAt).toLocaleDateString()} · ${state}`));
      row.addEventListener("click", () => open(item.id));
      list.append(row);
    }
  };
  void loadList();
}
