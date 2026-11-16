import type { PluginFrontendContext, PluginProblemRenderer } from "learnharness-plugin-api";
import { OPS, TOPICS, type ProjectsState } from "../shared/protocol.ts";
import { PANEL_ID } from "./editor-extension.ts";

type TaskPayload = { tests: { command: string; files?: Array<{ path: string; content: string }> } };
type TaskSubmission = { projectId: string };
interface TaskResult {
	projectName: string;
	snapshot: string | null;
	changes: string;
	command: string;
	status: "passed" | "failed" | "error";
	exitCode: number | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = doc.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/**
 * Project task dock: there is no code box — the submission is the attached project as
 * it is on disk. The editor shows which project will be submitted and the test command;
 * the submitted card shows the test run and the change summary.
 */
export function projectTaskRenderer(ctx: PluginFrontendContext): PluginProblemRenderer<TaskPayload, TaskSubmission> {
	return {
		id: "project-task",
		supportedContractVersions: [1],
		mountSubmissionEditor(container, context) {
			const doc = container.ownerDocument;
			const root = el(doc, "div", "lh-cw-task");
			const line = el(doc, "p", "lh-cw-task__line", "Checking the attached project…");
			const command = el(doc, "p", "lh-cw__time", `Tests: ${context.input.payload.tests.command}`);
			const open = el(doc, "button", "lh-cw-files__toggle", "Open the Coding pane");
			open.type = "button";
			open.addEventListener("click", () => ctx.app.openSessionPanel(context.chatId, PANEL_ID));
			root.append(line, command, open);
			container.append(root);

			let disposed = false;
			const load = () => {
				void ctx.call<ProjectsState>(OPS.projectsGet, { chatId: context.chatId }).then(state => {
					if (disposed) return;
					const p = state.attached;
					if (!p) {
						line.textContent = "No project workspace is attached. Attach one in the Coding pane, build the task there, then Submit.";
						context.onChange({ status: "unready", value: { projectId: "" } });
						return;
					}
					line.textContent = `Submit sends "${p.name}" as it is now — build it in your editor, then Submit. The tests run against the whole project.`;
					context.onChange({ status: "ready", value: { projectId: p.id } });
				}).catch(() => {});
			};
			const off = ctx.onNotification(event => { if (event.topic === TOPICS.projects) load(); });
			load();
			return {
				update() { /* the value tracks the attached project, not typing */ },
				focus() { open.focus(); },
				dispose() { disposed = true; off(); root.remove(); },
			};
		},
		mountSubmitted(container, context) {
			const doc = container.ownerDocument;
			const body = el(doc, "div", "lh-cw-task");
			const processing = context.processing;
			if (!processing) body.append(el(doc, "p", "lh-cw__time", "Project submitted"));
			else if ("error" in processing) body.append(el(doc, "p", "lh-cw-project__error", `Could not run the tests: ${processing.error}`));
			else {
				const r = processing.result as unknown as TaskResult;
				const label = r.status === "passed" ? "Tests passed" : r.status === "failed" ? `Tests failed (exit ${r.exitCode})` : r.timedOut ? "Tests timed out" : "Could not run tests";
				const header = context.headerContainer;
				if (header) {
					const slot = el(doc, "span");
					header.append(slot);
					ctx.ui.mountBadge(slot, { text: label, ...(r.status === "passed" ? {} : { color: "var(--destructive, #c33)" }) }, { signal: context.signal });
				}
				else body.append(el(doc, "strong", undefined, label));
				body.append(el(doc, "p", "lh-cw__time", `${r.projectName}${r.snapshot ? ` · snapshot ${r.snapshot.slice(0, 8)}` : ""} · ${r.command}`));
				if (r.changes) body.append(el(doc, "pre", "lh-cw__output", r.changes));
				for (const [text, cut] of [[r.stdout, r.stdoutTruncated], [r.stderr, r.stderrTruncated]] as const) {
					if (text) body.append(el(doc, "pre", "lh-cw__output", text + (cut ? "\n… (truncated)" : "")));
				}
			}
			(context.footerContainer ?? container).append(body);
		},
	};
}
