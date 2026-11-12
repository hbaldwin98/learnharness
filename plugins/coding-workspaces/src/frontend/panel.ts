import type { PluginFrontendContext, PluginSessionPanelContext } from "learnharness-plugin-api";
import { OPS, type CodingTestResult, type WorkspaceState } from "../shared/protocol.ts";
import { clockTime } from "../shared/trace.ts";
import { runItem } from "./editor-extension.ts";
import type { ViewStore } from "./store.ts";

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = doc.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

const DOCKER_TEXT = { missing: "Docker is not installed — Run is unavailable; Submit runs locally", stopped: "Docker is not running — start it to Run; Submit runs locally", running: "" } as const;

export function resultLabel(result: CodingTestResult): string {
	return result.status === "passed" ? "Tests passed" : result.status === "failed" ? `Tests failed (exit ${result.exitCode})` : "Could not run tests";
}

/** The workspace pane: status, Run, run output, narration strip with dictation and Ask, annotations. */
export function mountPanel(ctx: PluginFrontendContext, store: ViewStore, container: HTMLElement, panel: PluginSessionPanelContext): () => void {
	const doc = container.ownerDocument;
	const { signal, sessionId } = panel;
	const root = el(doc, "div", "lh-cw");
	container.append(root);

	const empty = el(doc, "p", "lh-cw__empty", "Open a coding question or problem to use the workspace. Run, narration and Ask apply to the code in its editor.");
	const body = el(doc, "div", "lh-cw__body");
	root.append(empty, body);

	const status = el(doc, "div", "lh-cw__status");
	status.setAttribute("role", "status");
	const actions = el(doc, "div", "lh-cw__actions");
	const runSlot = el(doc, "span");
	const askSlot = el(doc, "span");
	const dictationSlot = el(doc, "span");
	actions.append(runSlot, askSlot, dictationSlot);

	const narrationHeading = el(doc, "h3", "lh-cw__heading", "Narration");
	const narrationList = el(doc, "ol", "lh-cw__narration");
	const composerSlot = el(doc, "div", "lh-cw__composer");
	const annotationsHeading = el(doc, "h3", "lh-cw__heading", "Notes from the tutor");
	const annotationsList = el(doc, "ul", "lh-cw__annotations");
	const outdatedHeading = el(doc, "h3", "lh-cw__heading lh-cw__heading--muted", "Outdated notes");
	const outdatedList = el(doc, "ul", "lh-cw__annotations lh-cw__annotations--outdated");
	const runsHeading = el(doc, "h3", "lh-cw__heading", "Runs");
	const runsList = el(doc, "ol", "lh-cw__runs");
	body.append(status, actions, annotationsHeading, annotationsList, outdatedHeading, outdatedList, narrationHeading, narrationList, composerSlot, runsHeading, runsList);

	let draft = "";
	let asking = false;
	const current = () => {
		const ref = store.active(sessionId);
		return ref ? { ref, state: store.state(ref.chatId, ref.itemId) } : null;
	};
	const narrate = (text: string) => {
		const item = current();
		if (!item || !text.trim()) return;
		void ctx.call(OPS.narrate, { chatId: item.ref.chatId, itemId: item.ref.itemId, text }).catch(error => console.error(error));
	};
	const ask = async () => {
		const item = current();
		if (!item || asking) return;
		asking = true;
		render();
		try {
			await ctx.call(OPS.ask, { chatId: item.ref.chatId, itemId: item.ref.itemId, text: draft, code: item.ref.readCode() });
			draft = "";
			composer.update({ value: "" });
		} finally { asking = false; render(); }
	};

	const run = ctx.ui.mountButton(runSlot, {
		label: "Run", size: "sm", variant: "outline", title: "Run the tests in the sandbox (not graded)",
		onClick: async () => { const item = current(); if (item) await runItem(ctx, item.ref.chatId, item.ref.itemId, item.ref.readCode()); },
	}, { signal });
	const askButton = ctx.ui.mountButton(askSlot, { label: "Ask", size: "sm", title: "Send your draft and your work so far to the tutor", onClick: ask }, { signal });
	const dictation = ctx.ui.mountDictation(dictationSlot, { onTranscript: text => narrate(text) }, { signal });
	const composer = ctx.ui.mountComposer(composerSlot, {
		value: "", placeholder: "Think aloud… (Enter adds it to your narration; Ask sends it as a question)",
		onChange: value => { draft = value; },
		onSend: () => { narrate(draft); draft = ""; composer.update({ value: "" }); },
	}, { signal });

	function render() {
		const item = current();
		empty.hidden = Boolean(item?.state);
		body.hidden = !item?.state;
		const state: WorkspaceState | undefined = item?.state;
		if (!state) return;
		const lsp = state.diagnostics;
		const lines = [
			`${state.language}${state.image ? "" : " (no sandbox for this language)"}`,
			DOCKER_TEXT[state.docker],
			state.running ?? "",
			lsp.name ? `${lsp.name} language server: ${lsp.status}${lsp.status === "ready" ? ` · ${lsp.diagnostics.length} problem${lsp.diagnostics.length === 1 ? "" : "s"}` : ""}` : "",
			state.listening ? "The tutor looks in while you work" : "Listening is off",
		].filter(Boolean);
		status.replaceChildren(...lines.map(line => el(doc, "div", undefined, line)));
		run.update({ disabled: state.running !== null || !state.image || state.docker !== "running", label: state.running ? "Running…" : "Run" });
		askButton.update({ disabled: asking, label: asking ? "Asking…" : "Ask" });

		const live = state.annotations.filter(a => !a.outdated);
		const outdated = state.annotations.filter(a => a.outdated);
		annotationsHeading.hidden = annotationsList.hidden = live.length === 0;
		outdatedHeading.hidden = outdatedList.hidden = outdated.length === 0;
		const note = (a: (typeof state.annotations)[number]) => {
			const li = el(doc, "li");
			li.append(el(doc, "span", "lh-cw__lines", a.outdated ? "" : a.endLine > a.line ? `Lines ${a.line}–${a.endLine}` : `Line ${a.line}`), el(doc, "span", undefined, a.note));
			return li;
		};
		annotationsList.replaceChildren(...live.map(note));
		outdatedList.replaceChildren(...outdated.map(note));

		narrationList.replaceChildren(...state.narration.slice(-50).map(n => {
			const li = el(doc, "li");
			li.append(el(doc, "time", "lh-cw__time", clockTime(n.at)), el(doc, "span", undefined, n.text));
			return li;
		}));
		runsHeading.hidden = state.runs.length === 0;
		runsList.replaceChildren(...[...state.runs].reverse().slice(0, 5).map(r => {
			const li = el(doc, "li", "lh-cw__run");
			li.dataset.status = r.result.status;
			const summary = el(doc, "div", "lh-cw__run-summary");
			summary.append(el(doc, "time", "lh-cw__time", clockTime(r.at)), el(doc, "strong", undefined, resultLabel(r.result)));
			li.append(summary);
			for (const text of [r.result.notice, r.result.message].filter(Boolean) as string[]) li.append(el(doc, "p", "lh-cw__message", text));
			for (const [label, text, truncated] of [["stdout", r.result.stdout, r.result.stdoutTruncated], ["stderr", r.result.stderr, r.result.stderrTruncated]] as const) {
				if (!text) continue;
				const pre = el(doc, "pre", "lh-cw__output", text + (truncated ? "\n… (truncated at 64 KiB)" : ""));
				pre.setAttribute("aria-label", label);
				li.append(pre);
			}
			return li;
		}));
	}

	const unsubscribe = store.subscribe(render);
	render();
	return () => {
		unsubscribe();
		void dictation.finish().catch(() => {});
		root.remove();
	};
}

/** Ask from a shortcut: the pane's draft isn't reachable, so it sends the work without words. */
export async function askWithoutWords(ctx: PluginFrontendContext, store: ViewStore, sessionId: string): Promise<void> {
	const ref = store.active(sessionId);
	if (!ref) return;
	await ctx.call(OPS.ask, { chatId: ref.chatId, itemId: ref.itemId, text: "", code: ref.readCode() });
}
