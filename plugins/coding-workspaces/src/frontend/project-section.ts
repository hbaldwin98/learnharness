import type { PluginFrontendContext } from "learnharness-plugin-api";
import { OPS, TOPICS, type ProjectInfo, type ProjectsState } from "../shared/protocol.ts";
import { createFilesView } from "./files-view.ts";
import { createTerminalView } from "./terminal-view.ts";

const IMAGES = ["node", "python", "dotnet", "java", "go", "rust", "cpp"] as const;

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = doc.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/**
 * The Coding pane's Project section: the session's attached project workspace, and
 * create / attach / detach / remove. Always shown, whether or not an exercise is open.
 */
export function mountProjectSection(ctx: PluginFrontendContext, container: HTMLElement, chatId: string, signal: AbortSignal): () => void {
	const doc = container.ownerDocument;
	const root = el(doc, "section", "lh-cw-project");
	root.append(el(doc, "h3", "lh-cw__heading", "Project"));
	const body = el(doc, "div", "lh-cw-project__body");
	const error = el(doc, "p", "lh-cw-project__error");
	error.setAttribute("role", "alert");
	root.append(body, error);
	container.prepend(root);

	let state: ProjectsState | null = null;
	let mode: "view" | "create" | "attach" = "view";
	let busy = false;
	/** Widgets mounted by the current render; aborted before the next one. */
	let renderScope = new AbortController();
	signal.addEventListener("abort", () => renderScope.abort(), { once: true });

	const call = async (op: string, input: Record<string, unknown>) => {
		busy = true; error.textContent = ""; render();
		try { state = await ctx.call<ProjectsState>(op, { chatId, ...input }); mode = "view"; }
		catch (e) { error.textContent = e instanceof Error ? e.message : String(e); }
		finally { busy = false; render(); }
	};
	const refresh = () => { void ctx.call<ProjectsState>(OPS.projectsGet, { chatId }).then(next => { state = next; render(); files.refresh(); }).catch(() => {}); };
	const files = createFilesView(ctx, doc, chatId, id => void call(OPS.noteDismiss, { id }));
	const terminal = createTerminalView(ctx, doc, chatId);

	const button = (label: string, onClick: () => void, variant: "outline" | "default" = "outline") => {
		const slot = el(doc, "span");
		ctx.ui.mountButton(slot, { label, size: "sm", variant, disabled: busy, onClick }, { signal: renderScope.signal });
		return slot;
	};
	const field = (label: string, input: HTMLElement) => {
		const wrap = el(doc, "label", "lh-cw-project__field");
		wrap.append(el(doc, "span", undefined, label), input);
		return wrap;
	};

	function renderAttached(p: ProjectInfo) {
		const meta = el(doc, "div", "lh-cw-project__meta");
		meta.append(
			el(doc, "strong", undefined, p.name),
			el(doc, "div", undefined, `${p.image} · ${p.managed ? "managed folder" : "your folder"}${p.runCommand ? ` · run: ${p.runCommand}` : ""}`),
		);
		const pathRow = el(doc, "div", "lh-cw-project__path");
		const code = el(doc, "code", undefined, p.hostPath);
		pathRow.append(code, button("Copy path", () => { void navigator.clipboard?.writeText(p.hostPath); }));
		if (!p.exists) meta.append(el(doc, "div", "lh-cw-project__error", "The folder is missing on disk."));
		const others = p.sessions.filter(s => s !== chatId).length;
		if (others) meta.append(el(doc, "div", undefined, `Also used by ${others} other session${others === 1 ? "" : "s"}`));
		const actions = el(doc, "div", "lh-cw__actions");
		actions.append(
			button("Detach", () => void call(OPS.projectDetach, {})),
			button("Switch…", () => { mode = "attach"; render(); }),
		);
		files.setNotes(state?.notes ?? []);
		terminal.setProject(p.id, state?.runtime?.docker === "running");
		// Re-parenting the terminal blurs it: keep the learner's typing focus.
		const typing = doc.activeElement instanceof HTMLElement && terminal.element.contains(doc.activeElement) ? doc.activeElement : null;
		body.replaceChildren(meta, pathRow, actions, ...renderRuntime(p), terminal.element, files.element);
		typing?.focus();
	}

	/** Container status, the run command, Run/Stop, and recent runs. */
	function renderRuntime(p: ProjectInfo): HTMLElement[] {
		const rt = state?.runtime;
		if (!rt) return [];
		const status = el(doc, "div", "lh-cw__status");
		status.setAttribute("role", "status");
		const dockerLine = rt.docker === "missing" ? "Docker is not installed — the project needs it to run" : rt.docker === "stopped" ? "Docker is not running — start it to run the project" : rt.containerRunning ? "Container running" : "Container stopped (starts on Run)";
		status.append(el(doc, "div", undefined, dockerLine));
		if (rt.running) status.append(el(doc, "div", undefined, rt.running));

		const commandRow = el(doc, "div", "lh-cw-project__path");
		const command = el(doc, "input");
		command.type = "text"; command.value = p.runCommand; command.placeholder = "Run command, e.g. npm test";
		command.setAttribute("aria-label", "Run command");
		command.addEventListener("change", () => { if (command.value.trim() !== p.runCommand) void call(OPS.projectUpdate, { id: p.id, runCommand: command.value }); });
		commandRow.append(command);
		const runActions = el(doc, "div", "lh-cw__actions");
		if (rt.running) runActions.append(button("Stop", () => { void ctx.call(OPS.projectStop, { chatId }).catch(() => {}); }));
		else if (rt.docker === "running") runActions.append(button("Run", () => {
			error.textContent = "";
			void ctx.call(OPS.projectRun, { chatId, command: command.value }).catch(e => { error.textContent = e instanceof Error ? e.message : String(e); });
		}, "default"));

		const askRow = el(doc, "div", "lh-cw-project__path");
		const question = el(doc, "input");
		question.type = "text"; question.placeholder = "Ask the tutor about the project…";
		question.setAttribute("aria-label", "Question for the tutor");
		const ask = () => {
			error.textContent = "";
			const text = question.value;
			question.value = "";
			void ctx.call(OPS.projectAsk, { chatId, text }).catch(e => { error.textContent = e instanceof Error ? e.message : String(e); question.value = text; });
		};
		question.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); ask(); } });
		askRow.append(question, button("Ask", ask));

		const runs = el(doc, "ol", "lh-cw__runs");
		for (const r of [...rt.runs].reverse().slice(0, 3)) {
			const li = el(doc, "li", "lh-cw__run");
			li.dataset.status = r.error ? "error" : r.exitCode === 0 ? "passed" : "failed";
			const label = r.error ?? (r.timedOut ? "Timed out" : r.exitCode === 0 ? "Exited 0" : `Exited ${r.exitCode ?? "?"}`);
			const summary = el(doc, "div", "lh-cw__run-summary");
			summary.append(el(doc, "time", "lh-cw__time", new Date(r.at).toLocaleTimeString()), el(doc, "strong", undefined, label), el(doc, "code", undefined, r.command));
			li.append(summary);
			for (const [text, truncated] of [[r.stdout, r.stdoutTruncated], [r.stderr, r.stderrTruncated]] as const) {
				if (text) li.append(el(doc, "pre", "lh-cw__output", text + (truncated ? "\n… (truncated)" : "")));
			}
			runs.append(li);
		}
		return [...renderProposals(), status, commandRow, runActions, askRow, runs];
	}

	/** Tutor-proposed changes awaiting the learner: diff, explanation, Accept / Reject. */
	function renderProposals(): HTMLElement[] {
		const pending = state?.proposals ?? [];
		if (!pending.length) return [];
		const heading = el(doc, "h3", "lh-cw__heading", `Proposed changes (${pending.length})`);
		const list = el(doc, "ul", "lh-cw-project__proposals");
		for (const proposal of pending) {
			const li = el(doc, "li", "lh-cw-project__proposal");
			const title = el(doc, "div", "lh-cw__run-summary");
			title.append(el(doc, "code", undefined, proposal.path), el(doc, "span", "lh-cw__time", proposal.baseHash === null ? "new file" : "edit"));
			li.append(title);
			if (proposal.explanation) li.append(el(doc, "p", "lh-cw__message", proposal.explanation));
			const pre = el(doc, "pre", "lh-cw__output lh-cw-project__diff");
			for (const line of proposal.diff.split("\n")) {
				const span = el(doc, "span", line.startsWith("+") ? "lh-cw-project__add" : line.startsWith("-") ? "lh-cw-project__del" : undefined, `${line}\n`);
				pre.append(span);
			}
			const actions = el(doc, "div", "lh-cw__actions");
			actions.append(
				button("Accept", () => void call(OPS.proposalDecide, { id: proposal.id, accept: true }), "default"),
				button("Reject", () => void call(OPS.proposalDecide, { id: proposal.id, accept: false })),
			);
			li.append(pre, actions);
			list.append(li);
		}
		return [heading, list];
	}

	function renderCreate() {
		const name = el(doc, "input"); name.type = "text"; name.placeholder = "e.g. Todo API";
		const image = el(doc, "select");
		for (const i of IMAGES) image.append(Object.assign(el(doc, "option", undefined, i), { value: i }));
		const runCommand = el(doc, "input"); runCommand.type = "text"; runCommand.placeholder = "e.g. npm test (optional)";
		const folder = el(doc, "input"); folder.type = "text"; folder.placeholder = "Leave empty for a managed folder";
		const actions = el(doc, "div", "lh-cw__actions");
		actions.append(
			button("Create", () => void call(OPS.projectCreate, { name: name.value, image: image.value, runCommand: runCommand.value, ...(folder.value.trim() ? { folder: folder.value } : {}) }), "default"),
			button("Cancel", () => { mode = "view"; render(); }),
		);
		body.replaceChildren(field("Name", name), field("Language", image), field("Run command", runCommand), field("Folder (absolute path, optional)", folder), actions);
		name.focus();
	}

	function renderAttach(projects: ProjectInfo[]) {
		const list = el(doc, "ul", "lh-cw-project__list");
		for (const p of projects) {
			const li = el(doc, "li");
			const label = el(doc, "div");
			label.append(el(doc, "strong", undefined, p.name), el(doc, "div", "lh-cw__time", `${p.image} · ${p.sessions.length} session${p.sessions.length === 1 ? "" : "s"}`));
			li.append(label, button("Attach", () => void call(OPS.projectAttach, { id: p.id })), button("Remove…", () => {
				const deleteFiles = p.managed && confirm(`Also delete the managed folder for "${p.name}"? Its files cannot be recovered.\n\nOK deletes the files; Cancel keeps them.`);
				if (confirm(`Remove project "${p.name}"${deleteFiles ? " and delete its files" : ""}? Sessions using it are detached.`)) void call(OPS.projectRemove, { id: p.id, deleteFiles });
			}));
			list.append(li);
		}
		const actions = el(doc, "div", "lh-cw__actions");
		actions.append(button("New project…", () => { mode = "create"; render(); }), button("Cancel", () => { mode = "view"; render(); }));
		body.replaceChildren(projects.length ? list : el(doc, "p", "lh-cw__empty", "No projects yet."), actions);
	}

	function render() {
		renderScope.abort();
		renderScope = new AbortController();
		if (signal.aborted) return;
		if (!state) { body.replaceChildren(el(doc, "p", "lh-cw__empty", "Loading…")); return; }
		if (mode === "create") return renderCreate();
		if (mode === "attach") return renderAttach(state.projects.filter(p => p.id !== state?.attached?.id));
		if (state.attached) return renderAttached(state.attached);
		terminal.setProject(null, false);
		const actions = el(doc, "div", "lh-cw__actions");
		actions.append(button("New project…", () => { mode = "create"; render(); }));
		if (state.projects.length) actions.append(button("Attach existing…", () => { mode = "attach"; render(); }));
		body.replaceChildren(el(doc, "p", "lh-cw__empty", "No project workspace for this session. A project is a folder on your machine that this session (and others) can keep building on."), actions);
	}

	const off = ctx.onNotification(event => { if (event.topic === TOPICS.projects && mode === "view" && !busy && !doc.activeElement?.closest(".lh-cw-project input")) refresh(); });
	const offResync = ctx.onResync(refresh);
	refresh();
	render();
	return () => { off(); offResync(); renderScope.abort(); terminal.dispose(); root.remove(); };
}
