import type { PluginFrontendContext } from "learnharness-plugin-api";
import type { CodingEditorDiagnostic, CodingEditorExtension } from "../../../coding-questions/src/editor-hook.ts";
import { OPS, type WorkspaceState } from "../shared/protocol.ts";
import type { ViewStore } from "./store.ts";

const CODE_DEBOUNCE_MS = 400;
const PRESENCE_MS = 20_000;
export const PANEL_ID = "workspace";

/** Editor diagnostics: the language server's errors/warnings plus live annotations as notes. */
export function editorDiagnostics(state: WorkspaceState): CodingEditorDiagnostic[] {
	const out: CodingEditorDiagnostic[] = state.diagnostics.diagnostics.map(d => ({
		line: d.line, column: d.column, endLine: d.endLine, endColumn: d.endColumn, severity: d.severity, message: d.message, ...(d.source ? { source: d.source } : {}),
	}));
	for (const a of state.annotations) {
		if (a.outdated) continue;
		out.push({ line: a.line - 1, column: 0, endLine: a.endLine - 1, endColumn: Number.MAX_SAFE_INTEGER, severity: "info", message: a.note, source: "tutor" });
	}
	return out;
}

export function runItem(ctx: PluginFrontendContext, chatId: string, itemId: string, code: string): Promise<unknown> {
	return ctx.call(OPS.run, { chatId, itemId, code });
}

export function createEditorExtension(ctx: PluginFrontendContext, store: ViewStore): CodingEditorExtension {
	return {
		id: "coding-workspaces",
		mount(editor) {
			if (editor.kind !== "problem" && editor.kind !== "question") return;
			const { chatId, itemId, signal } = editor;
			const payload = (editor.payload ?? {}) as { tests?: unknown };
			const removeEditor = store.addEditor({ chatId, itemId, readCode: () => editor.readCode() });
			let opened = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const flush = () => {
				if (timer) { clearTimeout(timer); timer = undefined; }
				if (opened && !signal.aborted) void ctx.call(OPS.code, { chatId, itemId, code: editor.readCode() }).catch(() => {});
			};

			// Toolbar: Run (the problem's tests in the sandbox, ungraded) and the workspace pane.
			const document = editor.toolbar.ownerDocument;
			const runSlot = document.createElement("span");
			const paneSlot = document.createElement("span");
			editor.toolbar.append(runSlot, paneSlot);
			const run = ctx.ui.mountButton(runSlot, {
				label: "Run", size: "xs", variant: "outline", title: "Run the tests in the sandbox (not graded)",
				disabled: !editor.isActive(),
				onClick: async () => { flush(); await runItem(ctx, chatId, itemId, editor.readCode()); },
			}, { signal });
			ctx.ui.mountButton(paneSlot, {
				label: "Workspace", size: "xs", variant: "ghost", title: "Open the coding workspace pane",
				onClick: () => ctx.app.openSessionPanel(chatId, PANEL_ID),
			}, { signal });

			const apply = (state: WorkspaceState) => {
				if (state.chatId !== chatId || state.itemId !== itemId || signal.aborted) return;
				editor.setDiagnostics(editorDiagnostics(state));
				run.update({ disabled: !editor.isActive() || state.running !== null, label: state.running ? "Running…" : "Run" });
			};
			const unsubscribe = store.subscribe(() => { const state = store.state(chatId, itemId); if (state) apply(state); });
			const offChange = editor.onCodeChange(() => {
				if (timer) clearTimeout(timer);
				timer = setTimeout(flush, CODE_DEBOUNCE_MS);
			});
			const presence = () => { if (opened && document.visibilityState === "visible") void ctx.call(OPS.presence, { chatId, itemId }).catch(() => {}); };
			const heartbeat = setInterval(presence, PRESENCE_MS);

			void ctx.call<WorkspaceState>(OPS.open, { chatId, itemId, kind: editor.kind, language: editor.language, tests: payload.tests ?? null, code: editor.readCode() })
				.then(state => {
					if (signal.aborted) { void ctx.call(OPS.close, { chatId, itemId }).catch(() => {}); return; }
					opened = true;
					store.setState(state);
					presence();
				})
				.catch(error => console.error("[coding-workspaces] could not open the workspace", error));

			return () => {
				flush();
				clearInterval(heartbeat);
				offChange();
				unsubscribe();
				removeEditor();
				if (opened) void ctx.call(OPS.close, { chatId, itemId }).catch(() => {});
			};
		},
	};
}
