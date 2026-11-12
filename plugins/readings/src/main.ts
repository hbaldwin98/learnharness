/**
 * Readings frontend: the library + reading page (registerView), the session
 * tray (E2 panel), "Read deeper" on a tutor passage (E5 transcript-selection),
 * "Deep dive" on graph/Chains picks (E5 graph-selection), the discussed line
 * (E1 marker), the teacher's offer card (tool renderer) and settings.
 */
import type { PluginFrontendContext, PluginActionContext } from "learnharness-plugin-api";
import {
	DISCUSSED_MARKER_TYPE,
	MAX_NODE_PICKS,
	READING_KIND_LABEL,
	SUGGEST_READING_TOOL,
	type DiscussedMarkerData,
	type ReadingKind,
	type ReadingMode,
	type ReadingSummary,
} from "./contract.ts";
import { el, type Api, readingView, readingRow, modeToggle, getMode, setMode } from "./ui.ts";

const PANEL = "readings";
const BOOK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';

export function activate(ctx: PluginFrontendContext): () => void {
	const regs: Array<() => void> = [];
	const listeners = new Set<(topic: string, data: any) => void>();
	regs.push(ctx.onNotification((e) => listeners.forEach((l) => l(e.topic, e.data))));
	regs.push(ctx.onResync(() => listeners.forEach((l) => l("resync", {}))));
	const api: Api = {
		call: (op, input) => ctx.call(op, input ?? {}),
		ui: ctx.ui,
		listen(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		openSession: (id) => ctx.app.openSession(id),
		openReadingPage: (id) => openPage(id),
		createPractice: (title, nodeIds) => ctx.app.createSession({ kind: "practice", nodeIds, title }, { open: true }).then(() => undefined),
	};

	// ─── the reading page / library (one view; a pending id selects the page) ──
	let pageReading: string | null = null;
	let rerenderPage: (() => void) | null = null;
	function openPage(id: string | null) {
		pageReading = id;
		if (rerenderPage && ctx.app.pathname().includes("/plugins/")) rerenderPage();
		ctx.app.openView("library");
	}
	regs.push(
		ctx.registerView({
			id: "library",
			name: "Readings",
			mount(container, signal) {
				const root = el("div", { class: "rd-page" });
				container.append(root);
				let scope = new AbortController();
				const render = () => {
					scope.abort();
					scope = new AbortController();
					const s = AbortSignal.any([signal, scope.signal]);
					root.replaceChildren();
					if (pageReading) {
						const back = el("button", { class: "rd-link", type: "button" }, "← All readings");
						back.onclick = () => openPage(null);
						root.append(back);
						readingView(api, root, pageReading, { compact: false, signal: s, onOpenReading: (id) => openPage(id), onDeleted: () => openPage(null) });
					} else library(root, s);
				};
				rerenderPage = render;
				render();
				return () => {
					scope.abort();
					if (rerenderPage === render) rerenderPage = null;
					root.remove();
				};
			},
		}),
	);

	function library(root: HTMLElement, signal: AbortSignal) {
		root.append(topicBox(signal));
		const filters: Array<[string, string]> = [["all", "All"], ["recap", "Recaps"], ["primer", "Primers"], ["overview", "Overviews"], ["deep-dive", "Deep dives"]];
		let filter = "all";
		let query = "";
		let rows: ReadingSummary[] | null = null;
		const bar = el("div", { class: "rd-filters", role: "tablist" });
		const search = el("input", { class: "rd-input", placeholder: "Search…", "aria-label": "Search readings" }) as HTMLInputElement;
		const list = el("div", { class: "rd-list" });
		for (const [f, label] of filters) {
			const b = el("button", { type: "button", role: "tab", class: "rd-chip" }, label);
			b.onclick = () => {
				filter = f;
				paint();
			};
			bar.append(b);
		}
		search.oninput = () => {
			query = search.value.trim().toLowerCase();
			paint();
		};
		root.append(el("div", { class: "rd-row" }, bar, search), list);
		const match = (k: ReadingKind) => filter === "all" || (filter === "deep-dive" ? k === "deep-dive" || k === "node" : k === filter);
		function paint() {
			[...bar.children].forEach((b, i) => b.setAttribute("aria-selected", String(filters[i]![0] === filter)));
			list.replaceChildren();
			if (!rows) return list.append(el("div", { class: "rd-muted" }, "Loading…"));
			const shown = rows.filter((r) => match(r.kind) && (!query || r.title.toLowerCase().includes(query) || (r.chatTitle ?? "").toLowerCase().includes(query)));
			if (shown.length === 0) list.append(el("div", { class: "rd-muted" }, rows.length === 0 ? "No readings yet." : "Nothing matches."));
			for (const r of shown) list.append(readingRow(r, () => openPage(r.id), true));
		}
		const load = () =>
			api
				.call<ReadingSummary[]>("list")
				.then((v) => {
					if (!signal.aborted) {
						rows = v;
						paint();
					}
				})
				.catch(() => undefined);
		paint();
		void load();
		const off = api.listen((topic) => topic !== "answer" && void load());
		signal.addEventListener("abort", off);
	}

	function topicBox(signal: AbortSignal): HTMLElement {
		const box = el("section", { class: "rd-card" }, el("div", { class: "rd-strong" }, "On a topic, before you start"));
		const input = el("input", { class: "rd-input", placeholder: "A topic…", maxlength: "500" }) as HTMLInputElement;
		const error = el("div", { class: "rd-error" });
		let mode = getMode();
		const actions = el("div", { class: "rd-row" });
		for (const kind of ["primer", "overview"] as const) {
			const b = el("button", { type: "button", class: "rd-btn" }, kind === "primer" ? "Primer" : "Overview");
			b.onclick = async () => {
				if (!input.value.trim()) return;
				error.textContent = "";
				b.disabled = true;
				try {
					const { id } = await api.call<{ id: string }>("create", { kind, topic: input.value.trim(), mode });
					openPage(id);
				} catch (e) {
					error.textContent = (e as Error).message;
				} finally {
					b.disabled = false;
				}
			};
			actions.append(b);
		}
		actions.append(modeToggle(mode, (m) => {
			mode = m;
			setMode(m);
		}));
		box.append(input, actions, error);
		void signal;
		return box;
	}

	// ─── the session tray (E2) ─────────────────────────────────────────────
	const panelReading = new Map<string, string | null>();
	const panelRender = new Map<string, () => void>();
	function showInPanel(sessionId: string, readingId: string | null) {
		panelReading.set(sessionId, readingId);
		ctx.app.openSessionPanel(sessionId, PANEL);
		panelRender.get(sessionId)?.();
	}
	regs.push(
		ctx.registerSessionPanel({
			id: PANEL,
			title: "Readings",
			icon: BOOK,
			sessions: ["teaching"],
			defaultWidth: 448,
			mount(container, { sessionId, signal }) {
				const root = el("div", { class: "rd-panel" });
				container.append(root);
				let scope = new AbortController();
				const render = () => {
					scope.abort();
					scope = new AbortController();
					const s = AbortSignal.any([signal, scope.signal]);
					root.replaceChildren();
					const id = panelReading.get(sessionId) ?? null;
					if (id) {
						const head = el("div", { class: "rd-row" });
						const back = el("button", { type: "button", class: "rd-link" }, "← All readings");
						back.onclick = () => showInPanel(sessionId, null);
						const full = el("button", { type: "button", class: "rd-link rd-push" }, "Open full page");
						full.onclick = () => openPage(id);
						head.append(back, full);
						root.append(head);
						readingView(api, root, id, { compact: true, signal: s, onOpenReading: (next) => showInPanel(sessionId, next), onDeleted: () => showInPanel(sessionId, null) });
					} else trayList(root, sessionId, s);
				};
				panelRender.set(sessionId, render);
				render();
				return () => {
					scope.abort();
					if (panelRender.get(sessionId) === render) panelRender.delete(sessionId);
					root.remove();
				};
			},
		}),
	);

	function trayList(root: HTMLElement, chatId: string, signal: AbortSignal) {
		const kinds: Array<[ReadingKind, string, string]> = [
			["recap", "Recap", "What this session built so far, plus further reading"],
			["primer", "Primer", "The lesson's key terms, as definitions"],
			["overview", "Overview", "The map of the whole topic: its parts, why each exists, how they connect"],
			["deep-dive", "Deep dive", "The fuller story of one idea from the plan"],
		];
		let kind: ReadingKind = "recap";
		let mode = getMode();
		let nodes: Array<{ id: string; title: string }> = [];
		const card = el("section", { class: "rd-card" }, el("div", { class: "rd-strong" }, "New reading"));
		const kindBar = el("div", { class: "rd-row", role: "radiogroup", "aria-label": "Reading kind" });
		const hint = el("p", { class: "rd-muted" });
		const nodeSlot = el("div");
		const request = el("textarea", { class: "rd-input", rows: "2", maxlength: "2000", placeholder: "Optional: what should it focus on?" }) as HTMLTextAreaElement;
		const create = el("button", { type: "button", class: "rd-btn rd-primary rd-push" }, "Write it");
		const error = el("div", { class: "rd-error" });
		let nodeSelect: HTMLSelectElement | null = null;
		const paint = () => {
			[...kindBar.children].forEach((b, i) => b.setAttribute("aria-checked", String(kinds[i]![0] === kind)));
			hint.textContent = `${kinds.find((k) => k[0] === kind)![2]}.`;
			nodeSlot.replaceChildren();
			nodeSelect = null;
			if (kind === "deep-dive") {
				if (nodes.length === 0) nodeSlot.append(el("p", { class: "rd-muted" }, "No plan yet. Once the teacher presents one, pick an idea here — or select any passage in the lesson and choose “Read deeper”."));
				else {
					nodeSelect = el("select", { class: "rd-input" }, el("option", { value: "" }, "Pick an idea from the plan…"), ...nodes.map((n) => el("option", { value: n.id }, n.title))) as HTMLSelectElement;
					nodeSelect.onchange = () => (create.disabled = !nodeSelect!.value);
					nodeSlot.append(nodeSelect);
				}
			}
			create.disabled = kind === "deep-dive" && !nodeSelect?.value;
		};
		for (const [k, label, title] of kinds) {
			const b = el("button", { type: "button", role: "radio", class: "rd-chip", title }, label);
			b.onclick = () => {
				kind = k;
				paint();
			};
			kindBar.append(b);
		}
		create.onclick = async () => {
			create.disabled = true;
			error.textContent = "";
			try {
				const { id } = await api.call<{ id: string }>("create", { kind, chatId, mode, ...(kind === "deep-dive" ? { planNodeId: nodeSelect?.value } : {}), ...(request.value.trim() ? { request: request.value.trim() } : {}) });
				showInPanel(chatId, id);
			} catch (e) {
				error.textContent = (e as Error).message;
				create.disabled = false;
			}
		};
		card.append(kindBar, hint, nodeSlot, request, el("div", { class: "rd-row" }, modeToggle(mode, (m) => { mode = m; setMode(m); }), create), error,
			el("p", { class: "rd-fine" }, "Readings are optional and written in the background. The lesson carries on, and the teacher doesn’t see them."));
		const list = el("div", { class: "rd-list" });
		const lib = el("button", { type: "button", class: "rd-link rd-push" }, "Library");
		lib.onclick = () => openPage(null);
		root.append(card, el("div", { class: "rd-row rd-label" }, "This session", lib), list);
		paint();
		void api.call<{ nodes: typeof nodes }>("plan", { chatId }).then((p) => {
			if (!signal.aborted) {
				nodes = p.nodes;
				paint();
			}
		}).catch(() => undefined);
		const load = () =>
			api.call<ReadingSummary[]>("list", { chatId }).then((rows) => {
				if (signal.aborted) return;
				list.replaceChildren(...(rows.length ? rows.map((r) => readingRow(r, () => showInPanel(chatId, r.id), false)) : [el("div", { class: "rd-muted" }, "No readings yet.")]));
			}).catch(() => undefined);
		void load();
		const off = api.listen((topic, data) => {
			if (topic === "readings-changed" || topic === "resync") void load();
			if (topic === "session-settled" && data?.chatId === chatId) void api.call<{ nodes: typeof nodes }>("plan", { chatId }).then((p) => { nodes = p.nodes; if (kind === "deep-dive") paint(); });
		});
		signal.addEventListener("abort", off);
	}

	// ─── actions ───────────────────────────────────────────────────────────
	regs.push(ctx.registerAction({ id: "open", name: "Readings", icon: BOOK, run: () => openPage(null) }));
	regs.push(ctx.placeAction({ id: "open-sidebar", actionId: "open", location: "sidebar" }));
	regs.push(
		ctx.registerAction({
			id: "tray",
			name: "Readings",
			icon: BOOK,
			run: (c: PluginActionContext) => {
				if (c.placement === "top-bar" && c.surface === "session") showInPanel(c.sessionId, panelReading.get(c.sessionId) ?? null);
			},
		}),
	);
	regs.push(ctx.placeAction({ id: "tray-top-bar", actionId: "tray", location: "top-bar", sessions: ["teaching"], opens: PANEL }));
	regs.push(
		ctx.registerAction({
			id: "read-deeper",
			name: "Read deeper",
			icon: BOOK,
			disabled: (c) => c.placement === "transcript-selection" && c.kind !== "teaching",
			async run(c) {
				if (c.placement !== "transcript-selection") return;
				const { id } = await api.call<{ id: string }>("create", { kind: "deep-dive", chatId: c.sessionId, passage: c.selection.text, messageId: c.selection.messageId, mode: getMode() });
				showInPanel(c.sessionId, id);
			},
		}),
	);
	regs.push(ctx.placeAction({ id: "read-deeper-selection", actionId: "read-deeper", location: "transcript-selection" }));
	regs.push(
		ctx.registerAction({
			id: "deep-dive",
			name: "Deep dive",
			icon: BOOK,
			disabled: (c) => c.placement === "graph-selection" && c.nodeIds.length === 0,
			async run(c) {
				if (c.placement !== "graph-selection" || c.nodeIds.length === 0) return;
				if (c.nodeIds.length > MAX_NODE_PICKS && !(await confirmOverLimit(c.nodeIds.length))) return;
				const { id } = await api.call<{ id: string }>("create", { kind: "node", nodeIds: c.nodeIds.slice(0, MAX_NODE_PICKS), mode: getMode() });
				openPage(id);
			},
		}),
	);
	regs.push(ctx.placeAction({ id: "deep-dive-graph", actionId: "deep-dive", location: "graph-selection" }));

	function confirmOverLimit(n: number): Promise<boolean> {
		return new Promise((resolve) => {
			let done = false;
			const finish = (v: boolean) => {
				if (done) return;
				done = true;
				handle.dispose();
				resolve(v);
			};
			const cancel = el("button", { type: "button", class: "rd-btn" }, "Cancel");
			const go = el("button", { type: "button", class: "rd-btn rd-primary" }, "Deep dive anyway");
			cancel.onclick = () => finish(false);
			go.onclick = () => finish(true);
			const content = el("div", { class: "rd-dialog" }, el("h2", { class: "rd-strong" }, "Deep dive covers up to 64 propositions"), el("p", {}, `Only ${MAX_NODE_PICKS} of ${n} selected propositions will be included.`), el("div", { class: "rd-row rd-end" }, cancel, go));
			const handle = ctx.ui.openDialog({ title: "Deep dive covers up to 64 propositions", content, onClose: () => finish(false) }, { signal: ctx.signal });
		});
	}

	// ─── the discussed line (E1) ───────────────────────────────────────────
	regs.push(
		ctx.registerMarkerRenderer({
			typeId: DISCUSSED_MARKER_TYPE,
			mount(container, marker) {
				const data = marker.details as DiscussedMarkerData;
				const b = el("button", { type: "button", class: "rd-discussed" }, `You asked about “${data.readingTitle}”`);
				b.onclick = () => showInPanel(marker.sessionId, data.readingId);
				const line = el("div", { class: "rd-discussed-line" }, b);
				container.append(line);
				return () => line.remove();
			},
		}),
	);

	// ─── the teacher's offer card ──────────────────────────────────────────
	regs.push(
		ctx.registerToolRenderer({
			toolName: SUGGEST_READING_TOOL,
			mount(container, tool) {
				const input = (tool.input ?? {}) as { kind?: ReadingKind; title?: string; why?: string };
				if (!input.title || !input.kind || tool.state === "output-error") return;
				const actions = el("div", { class: "rd-row" });
				const error = el("div", { class: "rd-error" });
				const card = el("div", { class: "rd-offer" }, el("div", { class: "rd-label" }, `Optional reading · ${READING_KIND_LABEL[input.kind]}`), el("div", { class: "rd-strong" }, input.title), input.why ? el("div", { class: "rd-muted" }, input.why) : "", actions, error);
				container.append(card);
				let mode: ReadingMode = getMode();
				const paint = (offer: { chatId: string; readingId?: string } | null) => {
					actions.replaceChildren();
					if (!offer) return;
					if (offer.readingId) {
						const open = el("button", { type: "button", class: "rd-btn" }, "Open the reading");
						open.onclick = () => showInPanel(offer.chatId, offer.readingId!);
						actions.append(open);
						return;
					}
					const write = el("button", { type: "button", class: "rd-btn rd-primary" }, "Write it");
					write.onclick = async () => {
						write.disabled = true;
						error.textContent = "";
						try {
							const r = await api.call<{ id: string; chatId: string }>("accept-offer", { toolCallId: tool.toolCallId, mode });
							showInPanel(r.chatId, r.id);
							paint({ chatId: r.chatId, readingId: r.id });
						} catch (e) {
							error.textContent = (e as Error).message;
							write.disabled = false;
						}
					};
					actions.append(write, modeToggle(mode, (m) => { mode = m; setMode(m); }));
				};
				if (tool.state === "output-available") void api.call<{ chatId: string; readingId?: string } | null>("offer", { toolCallId: tool.toolCallId }).then((o) => !tool.signal.aborted && paint(o)).catch(() => undefined);
				return () => card.remove();
			},
		}),
	);

	// ─── settings: the writer model ────────────────────────────────────────
	regs.push(
		ctx.registerSettings((container: HTMLElement, signal: AbortSignal) => {
			const root = el("div", { class: "rd-settings" },
				el("div", { class: "rd-strong" }, "Writer model"),
				el("p", { class: "rd-muted" }, "Writes readings and answers Discuss questions. Unset: the strong model slot."));
			const modelSlot = el("div");
			const thinkingSlot = el("div");
			const error = el("div", { class: "rd-error" });
			root.append(modelSlot, thinkingSlot, error);
			container.append(root);
			void api.call<{ writerModel: { provider: string; id: string } | null; writerThinking?: string }>("get-settings").then((s) => {
				if (signal.aborted) return;
				const save = async (patch: object) => {
					error.textContent = "";
					try {
						s = await api.call("save-settings", patch);
						model.update({ value: s.writerModel ?? undefined });
						thinking.update({ model: s.writerModel ?? undefined, value: (s.writerThinking as never) ?? undefined });
					} catch (e) {
						error.textContent = (e as Error).message;
					}
				};
				const model = ctx.ui.mountModelPicker(modelSlot, { value: s.writerModel ?? undefined, onChange: (v) => save({ writerModel: v ?? null }) }, { signal });
				const thinking = ctx.ui.mountThinkingPicker(thinkingSlot, { model: s.writerModel ?? undefined, value: (s.writerThinking as never) ?? undefined, onChange: (v) => save({ writerThinking: v ?? null }) }, { signal });
				const clear = el("button", { type: "button", class: "rd-link" }, "Use the strong slot");
				clear.onclick = () => void save({ writerModel: null });
				root.append(clear);
			}).catch((e) => (error.textContent = (e as Error).message));
			return () => root.remove();
		}),
	);

	const dispose = () => {
		for (const r of regs.splice(0).reverse()) r();
		listeners.clear();
	};
	ctx.cleanup(dispose);
	return dispose;
}
