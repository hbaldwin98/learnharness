/** The Live screen: transcript, callouts, collapsed quiet turns, multiple-choice
 * cards, code editors, the plan panel and the answer bar. Dictation appends to an
 * answer buffer; only FINISHED text past the sent mark goes to the interviewer —
 * on a pause (shouldSendOnPause, timed from E10 commit events) or on Submit. */
import type { PluginDictationHandle, PluginFrontendContext } from "learnharness-plugin-api";
import { CHANGED_TOPIC, type InterviewEntry, type InterviewView } from "../contract.ts";
import { codeTurnText, interviewCodePath } from "../code.ts";
import { pauseProgress, shouldSendOnPause } from "../pause.ts";
import { renderDebrief, type DebriefStatus } from "./debrief.ts";
import { el, errorText, requestId } from "./dom.ts";
import { mountCodeEditor, readSavedCode, type CodeEditorHandle } from "./editor.ts";

const TICK_MS = 100;

export function mountLive(container: HTMLElement, ctx: PluginFrontendContext, signal: AbortSignal, id: string, back: () => void): void {
  const root = el("div", "lh-iv lh-iv-live");
  const header = el("header", "lh-iv-live-header");
  const crumbs = el("div", "lh-iv-row");
  const backButton = el("button", "lh-iv-link", "Interviews");
  backButton.type = "button";
  backButton.addEventListener("click", back);
  const title = el("span", "lh-iv-crumb-title");
  crumbs.append(backButton, el("span", "lh-iv-muted", "/"), title);
  const headerRight = el("div", "lh-iv-row");
  const progressLabel = el("span", "lh-iv-mono lh-iv-muted");
  headerRight.append(progressLabel);
  header.append(crumbs, headerRight);

  const body = el("div", "lh-iv-live-body");
  const main = el("section", "lh-iv-live-main");
  const column = el("div", "lh-iv-column");
  main.append(column);
  const plan = el("aside", "lh-iv-plan");
  body.append(main, plan);

  const footer = el("footer", "lh-iv-bar-wrap");
  const bar = el("div", "lh-iv-bar");
  const mic = el("div", "lh-iv-mic");
  const answer = el("textarea", "lh-iv-answer");
  answer.rows = 1;
  answer.setAttribute("aria-label", "Your answer");
  const countdown = el("div", "lh-iv-countdown");
  const countdownLabel = el("span", "lh-iv-mono lh-iv-muted");
  const track = el("div", "lh-iv-track");
  const fill = el("div", "lh-iv-fill");
  track.append(fill);
  countdown.append(countdownLabel, track);
  const submitSlot = el("div");
  bar.append(mic, answer, countdown, submitSlot);
  const barError = el("p", "lh-iv-error lh-iv-center");
  barError.setAttribute("role", "alert");
  footer.append(bar, barError);
  root.append(header, body, footer);
  container.append(root);

  // ── state ──
  let view: InterviewView | null = null;
  let sending = false;
  let buffer = "";
  let sentMark = 0;
  let changedAt = Date.now();
  let showTranscript = false;
  let debriefStatus: DebriefStatus = "idle";
  let debriefError: string | null = null;
  const editors = new Map<string, { node: HTMLElement; editor: CodeEditorHandle; questionId: string }>();
  let code: { questionId: string; language: string; content: string; sent: string | null } | null = null;
  let renderSignal: AbortController | null = null;

  const busy = () => sending || view?.status === "running";
  const ended = () => Boolean(view?.endedAt);
  const unsent = () => buffer.slice(sentMark);

  const writeBuffer = (value: string, at = Date.now()) => {
    buffer = value;
    if (sentMark > value.length) sentMark = value.length;
    changedAt = at;
    if (answer.value !== unsent()) answer.value = unsent();
    syncBar();
  };
  answer.addEventListener("input", () => writeBuffer(buffer.slice(0, sentMark) + answer.value));
  answer.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });

  // Finished speech arrives once per committed chunk: onCommit (E10) carries its
  // commit time, then onTranscript delivers the same text into the buffer.
  let lastCommitAt: number | null = null;
  const dictation: PluginDictationHandle = ctx.ui.mountDictation(mic, {
    onCommit: (_text, at) => { lastCommitAt = at; },
    onTranscript: (text) => {
      const piece = text.trim();
      if (!piece) return;
      const sep = buffer && !/\s$/.test(buffer) ? " " : "";
      writeBuffer(buffer + sep + piece, lastCommitAt ?? Date.now());
      lastCommitAt = null;
    },
  }, { signal });

  const send = async (text: string) => {
    sending = true;
    syncBar();
    barError.textContent = "";
    try {
      view = await ctx.call<InterviewView>("send", { id, text, requestId: requestId() });
    } catch (error) {
      barError.textContent = errorText(error);
    } finally {
      sending = false;
      if (!signal.aborted) render();
    }
  };

  const flush = (forceCode = false): boolean => {
    if (busy() || ended()) return false;
    const said = unsent();
    const codeChanged = code !== null && (forceCode || code.content !== code.sent);
    // Code alone never fires on a pause: only with speech, or Send code.
    if (!said.trim() && !forceCode) return false;
    const text = codeTurnText(said, codeChanged && code ? { language: code.language, content: code.content } : null);
    if (!text) return false;
    sentMark = buffer.length;
    if (code && codeChanged) code.sent = code.content;
    answer.value = "";
    void send(text);
    return true;
  };
  const submit = () => {
    void dictation.finish().catch((error: unknown) => { barError.textContent = errorText(error); }).then(() => flush());
  };
  const submitButton = ctx.ui.mountButton(submitSlot, { label: "Submit", onClick: submit, disabled: true }, { signal });

  const syncBar = () => {
    const off = !view || ended();
    answer.disabled = off;
    answer.placeholder = ended() ? "The interview has ended." : "Speak or type your answer…";
    dictation.update({ disabled: off });
    submitButton.update({ disabled: off || busy() || !unsent().trim() });
    if (view) {
      countdownLabel.textContent = view.listening.waitForSubmit ? "sends on Submit" : `sends after ${(view.listening.silenceMs / 1000).toFixed(1)}s quiet`;
      track.hidden = view.listening.waitForSubmit;
    }
  };

  // ── the pause tick ──
  const timer = setInterval(() => {
    if (!view) return;
    const state = {
      unsent: unsent(), tentative: "", msSinceChange: Date.now() - changedAt,
      silenceMs: view.listening.silenceMs, waitForSubmit: view.listening.waitForSubmit, busy: busy(),
    };
    fill.style.width = `${Math.round(pauseProgress(state) * 100)}%`;
    if (shouldSendOnPause(state)) flush();
  }, TICK_MS);
  signal.addEventListener("abort", () => {
    clearInterval(timer);
    for (const e of editors.values()) e.editor.destroy();
    editors.clear();
  }, { once: true });

  // ── the debrief ──
  const requestDebrief = async () => {
    if (debriefStatus === "writing") return;
    debriefStatus = "writing";
    debriefError = null;
    render();
    try {
      await ctx.call("debrief", { id });
      debriefStatus = "idle";
    } catch (error) {
      debriefStatus = "failed";
      debriefError = errorText(error);
    }
    if (!signal.aborted) await refresh();
  };
  const endButton = ctx.ui.mountButton(headerRight, {
    label: "End interview", variant: "outline", size: "sm", disabled: true,
    onClick: async () => {
      showTranscript = false;
      dictation.cancel();
      view = await ctx.call<InterviewView>("end", { id });
      render();
      void requestDebrief();
    },
  }, { signal });

  // ── rendering ──
  const entryNode = (e: InterviewEntry, live: boolean): HTMLElement => {
    switch (e.kind) {
      case "you": {
        const n = el("div", "lh-iv-turn");
        n.append(el("div", "lh-iv-label", "You"), el("div", "lh-iv-text", e.text));
        return n;
      }
      case "said": {
        if (e.accent) {
          const n = el("div", "lh-iv-callout");
          n.append(el("span", "lh-iv-callout-label", e.label ?? ""), el("span", undefined, e.text));
          return n;
        }
        const n = el("div", "lh-iv-turn");
        n.append(el("div", "lh-iv-label", `Interviewer${e.label ? ` · ${e.label}` : ""}`), el("div", "lh-iv-text", e.text));
        return n;
      }
      case "quiet":
        return el("div", "lh-iv-quiet", e.count === 1 ? "Interviewer stayed quiet." : `Interviewer stayed quiet for your last ${e.count} pauses.`);
      case "choice": {
        const n = el("div", "lh-iv-card lh-iv-choice");
        const head = el("div", "lh-iv-choice-head");
        head.append(el("span", "lh-iv-strong-text", e.prompt));
        if (live) head.append(el("span", "lh-iv-muted", "answer or keep talking"));
        n.append(head);
        for (const c of e.choices) {
          const b = el("button", "lh-iv-choice-option", c);
          b.type = "button";
          b.disabled = !live;
          b.addEventListener("click", () => { if (!busy() && !ended()) void send(`My answer: ${c}`); });
          n.append(b);
        }
        return n;
      }
      case "code": {
        let held = editors.get(e.id);
        if (!held) {
          const node = el("div", "lh-iv-card lh-iv-code");
          node.append(el("div", "lh-iv-strong-text", e.prompt));
          const meta = el("div", "lh-iv-code-meta");
          meta.append(el("span", "lh-iv-mono", interviewCodePath(e.starterCode.language)), el("span", "lh-iv-code-hint", "The interviewer sees your code with each answer."));
          const frame = el("div", "lh-iv-editor");
          const actions = el("div", "lh-iv-row lh-iv-end lh-iv-code-actions");
          node.append(meta, frame, actions);
          const initial = readSavedCode(id, e.questionId) ?? e.starterCode.code;
          const editor = mountCodeEditor(frame, {
            interviewId: id, questionId: e.questionId, language: e.starterCode.language, initial, editable: live,
            onChange: (content) => {
              code = { questionId: e.questionId, language: e.starterCode.language, content, sent: code?.questionId === e.questionId ? code.sent : null };
            },
          });
          ctx.ui.mountButton(actions, { label: "Send code", size: "sm", onClick: () => { flush(true); } }, { signal });
          held = { node, editor, questionId: e.questionId };
          editors.set(e.id, held);
        }
        held.editor.setEditable(live);
        held.node.classList.toggle("lh-iv-code-live", live);
        if (live && code?.questionId !== e.questionId) {
          code = { questionId: e.questionId, language: e.starterCode.language, content: held.editor.value(), sent: null };
        }
        return held.node;
      }
    }
  };

  const renderPlan = (v: InterviewView) => {
    plan.replaceChildren(el("div", "lh-iv-label", "Plan"));
    const list = el("ol", "lh-iv-plan-list");
    const at = v.questions.findIndex((q) => q.id === v.currentQuestionId);
    v.questions.forEach((q, i) => {
      const state = i < at || (v.endedAt && i <= at) ? "done" : i === at ? "current" : "todo";
      const item = el("li", `lh-iv-plan-${state}`, `${i + 1} · ${q.title}`);
      item.dataset.state = state;
      list.append(item);
    });
    plan.append(list);
  };

  function render() {
    if (signal.aborted || !view) return;
    const v = view;
    renderSignal?.abort();
    renderSignal = new AbortController();
    const local = AbortSignal.any([signal, renderSignal.signal]);
    title.textContent = v.setup.topic;
    const at = v.questions.findIndex((q) => q.id === v.currentQuestionId);
    progressLabel.textContent = at >= 0 ? `Q${at + 1} of ${v.questions.length}` : "";
    endButton.update({ disabled: busy() || ended() });
    renderPlan(v);
    column.replaceChildren();
    if (ended() && !showTranscript) {
      renderDebrief(column, ctx, local, {
        view: v, status: debriefStatus, error: debriefError,
        onRetry: () => { void requestDebrief(); },
        onShowTranscript: () => { showTranscript = true; render(); },
      });
    } else {
      if (ended()) ctx.ui.mountButton(column, { label: "Back to debrief", variant: "outline", size: "sm", onClick: () => { showTranscript = false; render(); } }, { signal: local });
      const lastChoice = v.entries.map((e) => e.kind).lastIndexOf("choice");
      const lastCode = v.entries.map((e) => e.kind).lastIndexOf("code");
      v.entries.forEach((e, i) => {
        const live = !ended() && (e.kind === "choice" ? i === lastChoice && !busy()
          : e.kind === "code" ? i === lastCode && v.currentQuestionId === e.questionId : false);
        column.append(entryNode(e, live));
      });
      if (busy()) {
        const thinking = el("div", "lh-iv-thinking", "Thinking…");
        thinking.setAttribute("role", "status");
        column.append(thinking);
      }
      if (v.error && v.status !== "running") {
        const alert = el("div", "lh-iv-error", v.error);
        alert.setAttribute("role", "alert");
        column.append(alert);
      }
    }
    syncBar();
    main.scrollTop = main.scrollHeight;
    // wrap_up ended it: write the debrief once the turn has settled.
    if (v.endedAt && !v.debrief && v.status !== "running" && debriefStatus === "idle") void requestDebrief();
  }

  const refresh = async () => {
    try {
      const next = await ctx.call<InterviewView>("get", { id });
      if (signal.aborted) return;
      view = next;
      render();
    } catch (error) {
      if (!signal.aborted) barError.textContent = errorText(error);
    }
  };
  const offNote = ctx.onNotification((event) => {
    if (event.topic === CHANGED_TOPIC && (event.data as { id?: string } | undefined)?.id === id) void refresh();
  });
  const offResync = ctx.onResync(() => { void refresh(); });
  signal.addEventListener("abort", () => { offNote(); offResync(); }, { once: true });
  void refresh();
}
