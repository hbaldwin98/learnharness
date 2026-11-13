import type { PluginFrontendContext } from "learnharness-plugin-api";
import type { InterviewSettings } from "./contract.ts";
import { SILENCE_MS_DEFAULT, SILENCE_MS_MAX, SILENCE_MS_MIN } from "./settings.ts";
import { el, errorText } from "./ui/dom.ts";
import { mountHome } from "./ui/home.ts";
import { mountLive } from "./ui/live.ts";

const VIEW_ID = "interview";
const MIC_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v5"/></svg>';

export function activate(ctx: PluginFrontendContext): void {
  // Which interview the view shows, per window (home when null).
  let openId: string | null = null;
  let remount: (() => void) | null = null;

  ctx.cleanup(ctx.registerView({
    id: VIEW_ID,
    name: "Interview",
    mount(container, signal) {
      let screen: AbortController | null = null;
      const show = () => {
        screen?.abort();
        screen = new AbortController();
        const local = AbortSignal.any([signal, screen.signal]);
        container.replaceChildren();
        if (openId) mountLive(container, ctx, local, openId, () => { openId = null; show(); });
        else mountHome(container, ctx, local, (id) => { openId = id; show(); });
      };
      remount = show;
      show();
      return () => { screen?.abort(); if (remount === show) remount = null; };
    },
  }));
  ctx.cleanup(ctx.registerAction({
    id: "open-interview",
    name: "Interview",
    icon: MIC_ICON,
    run: () => {
      openId = null;
      remount?.();
      ctx.app.openView(VIEW_ID);
    },
  }));
  ctx.cleanup(ctx.placeAction({ id: "interview-sidebar", actionId: "open-interview", location: "sidebar" }));

  ctx.cleanup(ctx.registerSettings((container, signal) => {
    const root = el("div", "lh-iv lh-iv-settings");
    const rows = el("div");
    const modelSection = el("div", "lh-iv-settings-model");
    const status = el("p", "lh-iv-error");
    status.setAttribute("role", "alert");
    root.append(rows, modelSection, status);
    container.append(root);
    void (async () => {
      let settings: InterviewSettings;
      try { settings = await ctx.call<InterviewSettings>("settings.get"); } catch (error) { status.textContent = errorText(error); return; }
      if (signal.aborted) return;
      const save = async (patch: Record<string, unknown>) => {
        settings = await ctx.call<InterviewSettings>("settings.set", patch);
        if (!signal.aborted) publish();
      };
      const schema = () => ({
        rows: [
          {
            key: "silence", type: "slider" as const, label: "Respond after silence (seconds)",
            description: "How long you pause before your answer goes to the interviewer.",
            value: (settings.silenceMs ?? SILENCE_MS_DEFAULT) / 1000, min: SILENCE_MS_MIN / 1000, max: SILENCE_MS_MAX / 1000, step: 0.5,
            disabled: settings.waitForSubmit ?? false,
            onChange: (seconds: number) => save({ silenceMs: Math.round(seconds * 1000) }),
          },
          {
            key: "wait", type: "toggle" as const, label: "Wait until I submit",
            description: "Ignore pauses; your answer goes only when you press Submit.",
            value: settings.waitForSubmit ?? false,
            onChange: (value: boolean) => save({ waitForSubmit: value }),
          },
        ],
      });
      const rowsHandle = ctx.ui.mountSettingsRows(rows, schema(), { signal });
      modelSection.append(el("div", "lh-iv-strong-text", "Interviewer model"),
        el("p", "lh-iv-muted", "Runs the live interviewer at its lowest thinking level. Default: your cheap model. Applies to new interviews."));
      const pickerSlot = el("div", "lh-iv-row");
      modelSection.append(pickerSlot);
      const picker = ctx.ui.mountModelPicker(pickerSlot, {
        value: settings.interviewerModel,
        onChange: (value) => save({ interviewerModel: { provider: value.provider, id: value.id } }),
      }, { signal });
      const reset = ctx.ui.mountButton(pickerSlot, {
        label: "Use cheap model", variant: "outline", size: "sm", disabled: !settings.interviewerModel,
        onClick: () => save({ interviewerModel: null }),
      }, { signal });
      const publish = () => {
        rowsHandle.update(schema());
        picker.update({ value: settings.interviewerModel });
        reset.update({ disabled: !settings.interviewerModel });
      };
    })();
  }));
}
