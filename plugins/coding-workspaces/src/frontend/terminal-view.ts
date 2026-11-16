import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { PluginFrontendContext } from "learnharness-plugin-api";
import { OPS, TOPICS } from "../shared/protocol.ts";

interface TerminalEvent { projectId: string; data?: string; exited?: boolean }

export interface TerminalView {
	element: HTMLElement;
	/** The attached project changed (or none): reset the terminal. */
	setProject(projectId: string | null, dockerRunning: boolean): void;
	dispose(): void;
}

/**
 * The project's shell in the Coding pane (collapsed until opened). xterm.js renders a
 * TTY exec in the project's container; output arrives as plugin events, keystrokes go
 * back as calls. Reopening replays the recent backlog.
 */
export function createTerminalView(ctx: PluginFrontendContext, doc: Document, chatId: string): TerminalView {
	const root = doc.createElement("div");
	root.className = "lh-cw-term";
	const header = doc.createElement("div");
	header.className = "lh-cw-term__header";
	const toggle = doc.createElement("button");
	toggle.type = "button";
	toggle.className = "lh-cw-files__toggle";
	toggle.textContent = "▸ Terminal";
	const status = doc.createElement("span");
	status.className = "lh-cw__time";
	const restart = doc.createElement("button");
	restart.type = "button";
	restart.className = "lh-cw-term__restart";
	restart.textContent = "Restart shell";
	restart.hidden = true;
	header.append(toggle, status, restart);
	const host = doc.createElement("div");
	host.className = "lh-cw-term__host";
	host.hidden = true;
	root.append(header, host);

	let projectId: string | null = null;
	let docker = false;
	let term: Terminal | null = null;
	let fit: FitAddon | null = null;
	let connected = false;
	let observer: ResizeObserver | null = null;
	let resizeTimer: ReturnType<typeof setTimeout> | undefined;

	const size = () => ({ cols: term?.cols ?? 80, rows: term?.rows ?? 24 });

	function ensureTerminal() {
		if (term) return;
		term = new Terminal({ fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", cursorBlink: true, convertEol: false, scrollback: 5000 });
		fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host);
		term.onData(data => {
			if (!connected) return;
			void ctx.call(OPS.terminalWrite, { chatId, data }).catch(() => { connected = false; showEnded("The shell is not running"); });
		});
		observer = new ResizeObserver(() => {
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => {
				if (host.hidden || !fit) return;
				try { fit.fit(); } catch { /* not laid out */ }
				if (connected) void ctx.call(OPS.terminalResize, { chatId, ...size() }).catch(() => {});
			}, 80);
		});
		observer.observe(host);
	}

	function showEnded(text: string) {
		status.textContent = text;
		restart.hidden = false;
	}

	async function connect() {
		if (!projectId) return;
		if (!docker) { status.textContent = "Docker is not running"; return; }
		ensureTerminal();
		try { fit?.fit(); } catch { /* not laid out */ }
		status.textContent = "Starting the shell…";
		restart.hidden = true;
		try {
			const opened = await ctx.call<{ projectId: string; backlog: string }>(OPS.terminalOpen, { chatId, ...size() });
			if (opened.projectId !== projectId) return;
			term?.reset();
			if (opened.backlog) term?.write(opened.backlog);
			connected = true;
			status.textContent = "/work in the project container";
			term?.focus();
		} catch (error) {
			showEnded(error instanceof Error ? error.message : String(error));
		}
	}

	toggle.addEventListener("click", () => {
		host.hidden = !host.hidden;
		toggle.textContent = `${host.hidden ? "▸" : "▾"} Terminal`;
		if (!host.hidden && !connected) void connect();
	});
	restart.addEventListener("click", () => { void connect(); });

	const off = ctx.onNotification(event => {
		if (event.topic !== TOPICS.terminal || !event.data || typeof event.data !== "object") return;
		const e = event.data as TerminalEvent;
		if (e.projectId !== projectId || !term) return;
		if (e.data && connected) term.write(e.data);
		if (e.exited) { connected = false; showEnded("The shell ended"); }
	});
	const offResync = ctx.onResync(() => { if (connected) { connected = false; void connect(); } });

	return {
		element: root,
		setProject(next, dockerRunning) {
			docker = dockerRunning;
			if (next === projectId) return;
			projectId = next;
			connected = false;
			term?.reset();
			status.textContent = "";
			restart.hidden = true;
			if (!host.hidden && next) void connect();
		},
		dispose() {
			off();
			offResync();
			clearTimeout(resizeTimer);
			observer?.disconnect();
			term?.dispose();
			root.remove();
		},
	};
}
