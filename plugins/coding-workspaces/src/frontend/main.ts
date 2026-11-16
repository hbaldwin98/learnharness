import type { PluginActionContext, PluginFrontendContext } from "learnharness-plugin-api";
import { codingEditorRegistry } from "../../../coding-questions/src/editor-hook.ts";
import { MARKERS, OPS, TOPICS, type CodeAnnotation, type WorkspaceState } from "../shared/protocol.ts";
import { createEditorExtension, PANEL_ID, runItem } from "./editor-extension.ts";
import { askWithoutWords, mountPanel } from "./panel.ts";
import { mountProjectSection } from "./project-section.ts";
import { mountSettings } from "./settings.ts";
import { createViewStore } from "./store.ts";

const CODE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';

const sessionOf = (context: PluginActionContext): string | null =>
	"sessionId" in context && typeof context.sessionId === "string" ? context.sessionId : null;

function line(container: HTMLElement, className: string, text: string): () => void {
	const p = container.ownerDocument.createElement("p");
	p.className = className;
	p.textContent = text;
	container.append(p);
	return () => p.remove();
}

export function activate(ctx: PluginFrontendContext): () => void {
	const store = createViewStore();
	const cleanups: Array<() => void> = [];

	cleanups.push(ctx.onNotification(event => {
		if (event.topic === TOPICS.state && event.data && typeof event.data === "object") store.setState(event.data as WorkspaceState);
	}));
	cleanups.push(ctx.onResync(() => {
		// Notifications are live only: re-read every shown item after a reconnect.
		for (const ref of store.all()) {
			void ctx.call<WorkspaceState>(OPS.get, { chatId: ref.chatId, itemId: ref.itemId }).then(state => store.setState(state)).catch(() => {});
		}
	}));

	cleanups.push(codingEditorRegistry().register(createEditorExtension(ctx, store)));

	cleanups.push(ctx.registerSessionPanel({
		id: PANEL_ID,
		title: "Coding",
		icon: CODE_ICON,
		defaultWidth: 380,
		mount: (container, panel) => {
			const unmountPanel = mountPanel(ctx, store, container, panel);
			const unmountProject = mountProjectSection(ctx, container, panel.sessionId, panel.signal);
			return () => { unmountProject(); unmountPanel(); };
		},
	}));

	cleanups.push(ctx.registerMarkerRenderer({
		typeId: MARKERS.trace,
		mount: container => line(container, "lh-cw-marker", "Workspace trace sent with the submission (narration, Runs and editor problems)"),
	}));
	cleanups.push(ctx.registerToolRenderer({
		toolName: "stay_quiet",
		mount: (container, tool) => line(container, "lh-cw-marker", tool.state === "output-error" ? "stay_quiet refused" : "Tutor looked · nothing to add"),
	}));
	cleanups.push(ctx.registerToolRenderer({
		toolName: "annotate",
		mount: (container, tool) => {
			const details = tool.result?.details as { annotation?: CodeAnnotation } | undefined;
			const a = details?.annotation;
			if (tool.state === "output-error") return line(container, "lh-cw-marker", tool.errorText ?? "Annotation refused");
			if (!a) return line(container, "lh-cw-marker", "Annotating your code…");
			return line(container, "lh-cw-marker", `Note on line${a.endLine > a.line ? `s ${a.line}–${a.endLine}` : ` ${a.line}`}: ${a.note}`);
		},
	}));

	cleanups.push(ctx.registerMarkerRenderer({
		typeId: MARKERS.proposal,
		mount: (container, marker) => {
			const d = marker.details as { path?: string; status?: string } | undefined;
			const outcome = d?.status === "accepted" ? "accepted" : d?.status === "rejected" ? "rejected" : "not applied (the file changed)";
			return line(container, "lh-cw-marker", `Proposed change to ${d?.path ?? "a file"} ${outcome}`);
		},
	}));
	cleanups.push(ctx.registerToolRenderer({
		toolName: "project_propose_edit",
		mount: (container, tool) => {
			if (tool.state === "output-error") return line(container, "lh-cw-marker", tool.errorText ?? "Proposal refused");
			const p = (tool.result?.details as { proposal?: { path: string } } | undefined)?.proposal;
			return line(container, "lh-cw-marker", p ? `Proposed a change to ${p.path} — review it in the Coding pane` : "Proposing a change…");
		},
	}));

	cleanups.push(ctx.registerSettings((container, signal) => mountSettings(ctx, container, signal)));

	// Shortcuts (the old fork's defaults; Submit stays coding-questions' host Submit).
	const scope = { sessions: ["teaching", "practice"] as ("teaching" | "practice")[] };
	cleanups.push(ctx.registerAction({
		id: "run", name: "Coding · run the tests", shortcut: { scope, defaultBinding: "mod+'" },
		run: async context => {
			const sessionId = sessionOf(context);
			const ref = sessionId ? store.active(sessionId) : undefined;
			if (ref) await runItem(ctx, ref.chatId, ref.itemId, ref.readCode());
		},
	}));
	cleanups.push(ctx.registerAction({
		id: "ask", name: "Coding · ask the tutor", shortcut: { scope, defaultBinding: "mod+;" },
		run: async context => { const sessionId = sessionOf(context); if (sessionId) await askWithoutWords(ctx, store, sessionId); },
	}));
	cleanups.push(ctx.registerAction({
		id: "open-workspace", name: "Coding · open the workspace pane", shortcut: { scope },
		run: context => { const sessionId = sessionOf(context); if (sessionId) ctx.app.openSessionPanel(sessionId, PANEL_ID); },
	}));

	return () => { for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch (error) { console.error(error); } } };
}
