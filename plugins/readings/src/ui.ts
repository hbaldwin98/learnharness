/** DOM rendering of one reading and its Discuss threads (port of the fork's
 * reading-view.tsx, discussion.tsx and the Graphite reading TOC). */
import type { PluginUi } from "learnharness-plugin-api";
import {
	discussionMarkdown,
	exchangeIsLive,
	markdownBlocks,
	markUnverifiedLinks,
	placeThreads,
	READING_KIND_LABEL,
	readingMarkdown,
	renderedBlockKeys,
	type DiscussionExchange,
	type DiscussionThread,
	type PlanNodeStatus,
	type ReadingDiscussionRecord,
	type ReadingMode,
	type ReadingProposition,
	type ReadingRecord,
	type ReadingSummary,
} from "./contract.ts";

export interface Api {
	call<T = any>(op: string, input?: object): Promise<T>;
	ui: PluginUi;
	listen(fn: (topic: string, data: any) => void): () => void;
	openSession(id: string): void;
	openReadingPage(id: string): void;
	createPractice(title: string, nodeIds: string[]): Promise<void>;
}
type FullReading = ReadingRecord & { practice: ReadingProposition[]; chatTitle?: string; planStatus?: Record<string, PlanNodeStatus> };

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
	node.append(...children);
	return node;
}

const MODE_KEY = "lh:readings:mode";
export function getMode(): ReadingMode {
	try {
		return localStorage.getItem(MODE_KEY) === "model" ? "model" : "researched";
	} catch {
		return "researched";
	}
}
export function setMode(m: ReadingMode) {
	try {
		localStorage.setItem(MODE_KEY, m);
	} catch {
		/* per-browser convenience only */
	}
}

export function modeToggle(initial: ReadingMode, onChange: (m: ReadingMode) => void, titles = ["Web research with verified citations", "Faster and cheaper — written from model knowledge, not source-checked"]): HTMLElement {
	const group = el("div", { class: "rd-toggle", role: "radiogroup", "aria-label": "Source mode" });
	let mode = initial;
	const opts: Array<[ReadingMode, string, string]> = [["researched", "Researched", titles[0]!], ["model", "AI only", titles[1]!]];
	const paint = () => [...group.children].forEach((b, i) => b.setAttribute("aria-checked", String(opts[i]![0] === mode)));
	for (const [m, label, title] of opts) {
		const b = el("button", { type: "button", role: "radio", title }, label);
		b.onclick = () => {
			mode = m;
			paint();
			onChange(m);
		};
		group.append(b);
	}
	paint();
	return group;
}

export function modeLabel(mode: ReadingMode): HTMLElement {
	return mode === "researched" ? el("span", { class: "rd-muted" }, "Researched") : el("span", { class: "rd-warn", title: "Written from model knowledge — no sources were read" }, "AI only · not source-checked");
}

function ago(iso: string): string {
	const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

export function readingRow(r: ReadingSummary, onOpen: () => void, showSession: boolean): HTMLElement {
	const live = r.status === "queued" || r.status === "writing";
	const meta = el("span", { class: "rd-muted" });
	if (live) meta.append(r.status === "queued" ? "Queued…" : r.activity || "Writing…");
	else if (r.status === "error") meta.append(el("span", { class: "rd-error" }, r.error === "Stopped" ? "Stopped" : "Failed"));
	else meta.append(`${READING_KIND_LABEL[r.kind]} · `, modeLabel(r.mode), ` · ${ago(r.createdAt)}${showSession && r.chatTitle ? ` · ${r.chatTitle}` : ""}`);
	const b = el("button", { type: "button", class: "rd-item" }, el("span", { class: "rd-strong" }, r.title), meta);
	b.onclick = onOpen;
	return b;
}

function markdown(api: Api, container: HTMLElement, text: string, signal: AbortSignal) {
	return api.ui.mountMarkdown(container, { text }, { signal });
}

function download(name: string, text: string) {
	const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
	const a = el("a", { href: url, download: name }) as HTMLAnchorElement;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** One reading, live: status, document, Discuss, actions. */
export function readingView(api: Api, root: HTMLElement, id: string, opts: { compact: boolean; signal: AbortSignal; onOpenReading: (id: string) => void; onDeleted: () => void }) {
	const host = el("div", { class: opts.compact ? "rd-reader rd-compact" : "rd-reader" });
	root.append(host);
	let reading: FullReading | null = null;
	let discussion: ReadingDiscussionRecord | null = null;
	let scope = new AbortController();
	let draft: { passage: string; blockKey?: string } | null = null;
	let discussOpen = false;
	const live = new Map<string, { text: string; activity: string }>();
	const liveNodes = new Map<string, { answer: HTMLElement; activity: HTMLElement; md?: ReturnType<typeof markdown> }>();

	async function load() {
		try {
			const r = await api.call<FullReading | null>("get", { id });
			if (opts.signal.aborted) return;
			if (!r) {
				host.replaceChildren(el("div", { class: "rd-muted" }, "This reading no longer exists."));
				return;
			}
			reading = r;
			discussion = r.status === "ready" ? await api.call<ReadingDiscussionRecord | null>("discussion", { readingId: id }) : null;
			if (!opts.signal.aborted) render();
		} catch {
			host.replaceChildren(el("div", { class: "rd-muted" }, "Couldn’t load this reading. It will retry on the next update."));
		}
	}

	function render() {
		const r = reading!;
		scope.abort();
		scope = new AbortController();
		const signal = AbortSignal.any([opts.signal, scope.signal]);
		liveNodes.clear();
		const keepScroll = host.closest(".rd-panel, .rd-page")?.parentElement;
		const scrollTop = keepScroll?.scrollTop ?? 0;
		host.replaceChildren();
		const ready = r.status === "ready";
		const rendered = ready ? renderedBlockKeys(r) : new Set<string>();
		const placed = placeThreads(discussion?.threads ?? [], rendered);
		const article = el("article", { class: "rd-article", "data-status": r.status });
		const head = el("div", { class: "rd-row rd-meta" }, el("span", { class: "rd-badge" }, READING_KIND_LABEL[r.kind]), modeLabel(r.mode), el("span", { class: "rd-muted" }, `· ${ago(r.createdAt)}`));
		const asked = discussion ? discussion.side.exchanges.length + discussion.threads.reduce((n, t) => n + t.exchanges.length, 0) : 0;
		if (opts.compact && ready) {
			const b = el("button", { type: "button", class: "rd-chip rd-push" }, `Discuss${asked ? ` · ${asked}` : ""}`);
			b.onclick = () => {
				discussOpen = true;
				render();
			};
			head.append(b);
		}
		article.append(head, el("h1", { class: "rd-title" }, r.title));
		if (!opts.compact && r.anchor.chatId && r.chatTitle) {
			const link = el("button", { type: "button", class: "rd-link" }, `From the session “${r.chatTitle}” →`);
			link.onclick = () => api.openSession(r.anchor.chatId!);
			article.append(link);
		}
		if (r.anchor.passage) article.append(el("blockquote", { class: "rd-quote" }, r.anchor.passage));
		if (r.request) article.append(el("p", { class: "rd-muted" }, `Your request: ${r.request}`));
		if (r.status === "queued" || r.status === "writing") {
			const stop = el("button", { type: "button", class: "rd-link" }, "Stop");
			stop.onclick = () => void api.call("stop", { id });
			article.append(el("div", { class: "rd-live" }, el("span", {}, r.status === "queued" ? "Queued…" : r.activity || "Writing…"), stop));
		}
		if (r.status === "error") article.append(el("div", { class: "rd-error-box" }, r.error === "Stopped" ? "Stopped before it was finished." : `Couldn't write this reading: ${r.error ?? "unknown error"}`));
		const content = el("div", { class: "rd-content" });
		const blocks = (text: string, prefix: string) => {
			const wrap = el("div", { class: "rd-blocks" });
			markdownBlocks(text).forEach((block, i) => {
				const key = `${prefix}:${i}`;
				const b = el("div", { "data-discuss-block": key });
				markdown(api, b, block, signal);
				wrap.append(b);
				for (const t of placed.inline.get(key) ?? []) wrap.append(threadCard(t, signal));
				if (draft?.blockKey === key) wrap.append(draftCard(signal));
			});
			return wrap;
		};
		if (ready) {
			if (r.body) content.append(blocks(r.body, "body"));
			(r.sections ?? []).forEach((sec, i) => {
				const s = el("section", { class: "rd-section" }, el("h2", {}, sec.heading));
				const titles = new Map((r.snapshot.planNodes ?? []).map((n) => [n.id, n.title] as const));
				if (sec.planNodeIds?.length) s.append(el("div", { class: "rd-row" }, ...sec.planNodeIds.map((nid) => nodeChip(r, nid, titles.get(nid) ?? nid))));
				s.append(blocks(sec.body, `sec:${i}`));
				content.append(s);
			});
			if (r.terms?.length) {
				const dl = el("dl", { class: "rd-terms" });
				r.terms.forEach((t, i) => {
					const dt = el("dt");
					markdown(api, dt, t.term, signal);
					const dd = el("dd");
					dd.append(blocks(t.definition, `term:${i}`));
					dl.append(el("div", { class: "rd-term" }, dt, dd));
				});
				content.append(dl);
			}
			if (r.furtherReading?.length) {
				content.append(el("h2", { class: "rd-label" }, "Further reading"), el("ul", { class: "rd-sources" }, ...r.furtherReading.map((f) => el("li", {}, el("a", { href: f.url, target: "_blank", rel: "noreferrer noopener" }, f.title), f.level ? el("span", { class: "rd-label" }, ` ${f.level}`) : "", el("div", { class: "rd-muted" }, f.why)))));
			}
			if (r.sources?.length) content.append(el("h2", { class: "rd-label" }, "Sources"), el("ol", { class: "rd-sources" }, ...r.sources.map((s) => el("li", {}, el("a", { href: s.url, target: "_blank", rel: "noreferrer noopener" }, s.title)))));
		}
		article.append(content, footer(r));
		if (ready) passageAsk(content, signal);

		if (opts.compact) {
			if (discussOpen && ready) {
				const back = el("button", { type: "button", class: "rd-link" }, "← Reading");
				back.onclick = () => {
					discussOpen = false;
					render();
				};
				host.append(el("div", { class: "rd-discuss-view" }, back, el("h2", { class: "rd-strong" }, r.title), sidePanel(placed.fallback, signal)));
			} else host.append(article);
		} else if (ready) {
			const aside = el("aside", { class: "rd-discuss-column", "aria-label": "Discuss" }, el("h2", { class: "rd-label" }, "Discuss"), sidePanel(placed.fallback, signal), toc(content, signal));
			host.append(el("div", { class: "rd-grid" }, article, aside));
		} else host.append(article);
		if (keepScroll) keepScroll.scrollTop = scrollTop;
	}

	function nodeChip(r: FullReading, nodeId: string, title: string): HTMLElement {
		const status = r.planStatus?.[nodeId];
		const chip = el("span", { class: "rd-node", "data-status": status ?? "gone" }, title);
		if (status) chip.append(el("span", { class: "rd-muted" }, ` · ${status[0]!.toUpperCase()}${status.slice(1)}`));
		if (status && r.anchor.chatId) {
			const b = el("button", { type: "button", class: "rd-link" }, "Read deeper") as HTMLButtonElement;
			b.onclick = async () => {
				b.disabled = true;
				try {
					const { id: next } = await api.call<{ id: string }>("create", { kind: "deep-dive", chatId: r.anchor.chatId, planNodeId: nodeId, mode: getMode() });
					opts.onOpenReading(next);
				} catch (e) {
					b.title = (e as Error).message;
					b.disabled = false;
				}
			};
			chip.append(b);
		}
		return chip;
	}

	function footer(r: FullReading): HTMLElement {
		const f = el("footer", { class: "rd-row rd-footer" });
		const error = el("div", { class: "rd-error" });
		const live = r.status === "queued" || r.status === "writing";
		if (r.status === "ready" && r.practice.length > 0) {
			const b = el("button", { type: "button", class: "rd-btn rd-primary", title: `Practice the ${r.practice.length} proposition${r.practice.length === 1 ? "" : "s"} this reading covers` }, "Practice this") as HTMLButtonElement;
			b.onclick = async () => {
				b.disabled = true;
				try {
					await api.createPractice(r.title, r.practice.map((p) => p.id).slice(0, 64));
				} catch {
					error.textContent = "Couldn't start a practice session";
				}
				b.disabled = false;
			};
			f.append(b);
		}
		if (r.status === "ready") {
			const b = el("button", { type: "button", class: "rd-btn" }, "Download");
			b.onclick = () => download(`${r.title.replace(/[^\w-]+/g, "-").slice(0, 60) || "reading"}.md`, [readingMarkdown(r), discussionMarkdown(discussion)].filter(Boolean).join("\n"));
			f.append(b);
		}
		if (!live) {
			let mode = r.mode;
			const b = el("button", { type: "button", class: "rd-btn" }, r.kind === "recap" ? "Update" : "Re-run") as HTMLButtonElement;
			b.onclick = async () => {
				b.disabled = true;
				try {
					const { id: next } = await api.call<{ id: string }>("create", { rerunOf: r.id, mode });
					opts.onOpenReading(next);
				} catch (e) {
					error.textContent = (e as Error).message;
					b.disabled = false;
				}
			};
			f.append(b, modeToggle(mode, (m) => (mode = m)));
		}
		const del = el("button", { type: "button", class: "rd-link rd-push", "aria-label": "Delete reading" }, "Delete");
		del.onclick = () => {
			del.replaceWith(confirm);
		};
		const yes = el("button", { type: "button", class: "rd-btn rd-danger" }, "Delete");
		const no = el("button", { type: "button", class: "rd-btn" }, "Cancel");
		const confirm = el("span", { class: "rd-row rd-push" }, el("span", { class: "rd-muted" }, "Delete permanently?"), no, yes);
		no.onclick = () => confirm.replaceWith(del);
		yes.onclick = async () => {
			const res = await api.call<{ ok: boolean }>("delete", { id }).catch(() => ({ ok: false }));
			if (res.ok) opts.onDeleted();
			else error.textContent = "Couldn't delete the reading";
		};
		f.append(del);
		return el("div", {}, f, error);
	}

	// ─── Discuss ───────────────────────────────────────────────────────────
	function exchangeItem(x: DiscussionExchange, signal: AbortSignal): HTMLElement {
		const isLive = exchangeIsLive(x);
		const node = el("div", { class: "rd-exchange", "data-status": x.status }, el("div", { class: "rd-question" }, x.question));
		const answer = el("div", { class: "rd-answer" });
		node.append(answer);
		const stream = live.get(x.id);
		const text = isLive ? (stream?.text ?? x.answer ?? "") : x.answer ? markUnverifiedLinks(x.answer, x.unverifiedUrls ?? []) : "";
		const md = markdown(api, answer, text, signal);
		if (isLive) {
			const activity = el("span", {}, x.status === "queued" ? "Queued…" : stream?.activity || x.activity || "answering");
			const stop = el("button", { type: "button", class: "rd-link" }, "Stop");
			stop.onclick = () => void api.call("stop-answer", { exchangeId: x.id });
			node.append(el("div", { class: "rd-live" }, activity, stop));
			liveNodes.set(x.id, { answer, activity, md });
		}
		if (x.status === "error") node.append(el("div", { class: "rd-error" }, x.error === "Stopped" ? "Stopped before it was finished." : `Couldn't answer: ${x.error ?? "unknown error"}`));
		if (x.status === "done" && x.sources?.length) node.append(el("ol", { class: "rd-sources rd-small" }, ...x.sources.map((s) => el("li", {}, el("a", { href: s.url, target: "_blank", rel: "noreferrer noopener" }, s.title)))));
		if (!isLive) node.append(el("div", { class: "rd-small" }, x.mode === "model" ? el("span", { class: "rd-warn" }, "AI only · not source-checked") : el("span", { class: "rd-muted" }, "Researched")));
		return node;
	}

	function askBox(placeholder: string, busy: boolean, build: (q: string, m: ReadingMode) => object, onAsked?: () => void, onCancel?: () => void): HTMLElement {
		let mode = reading!.mode;
		const input = el("textarea", { class: "rd-input", rows: "1", placeholder: busy ? "Answering…" : placeholder }) as HTMLTextAreaElement;
		input.disabled = busy;
		const send = el("button", { type: "button", class: "rd-btn", "aria-label": "Ask" }, "Ask") as HTMLButtonElement;
		const error = el("div", { class: "rd-error" });
		const submit = async () => {
			const q = input.value.trim();
			if (!q || busy) return;
			send.disabled = true;
			error.textContent = "";
			try {
				await api.call("ask", { readingId: id, ...build(q, mode) });
				input.value = "";
				onAsked?.();
			} catch (e) {
				error.textContent = (e as Error).message;
			}
			send.disabled = false;
		};
		send.onclick = () => void submit();
		input.onkeydown = (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
				e.preventDefault();
				void submit();
			} else if (e.key === "Escape" && onCancel) {
				e.preventDefault();
				onCancel();
			}
		};
		const row = el("div", { class: "rd-row" }, modeToggle(mode, (m) => (mode = m), ["Web research; only fetched pages are listed as sources", "Faster and cheaper — answered from model knowledge, not source-checked"]));
		if (onCancel) {
			const c = el("button", { type: "button", class: "rd-link rd-push" }, "Cancel");
			c.onclick = onCancel;
			row.append(c);
		}
		return el("div", { class: "rd-ask" }, el("div", { class: "rd-row" }, input, send), row, error);
	}

	function threadCard(t: DiscussionThread, signal: AbortSignal): HTMLElement {
		const card = el("div", { class: "rd-thread" });
		if (t.passage) card.append(el("blockquote", { class: "rd-quote" }, t.passage));
		for (const x of t.exchanges) card.append(exchangeItem(x, signal));
		const busy = t.exchanges.some(exchangeIsLive);
		if (!busy) {
			const reply = el("button", { type: "button", class: "rd-link" }, "Reply");
			reply.onclick = () => reply.replaceWith(askBox("Follow up…", false, (q, m) => ({ question: q, mode: m, threadId: t.id }), undefined, () => render()));
			card.append(reply);
		}
		return card;
	}

	function draftCard(_signal: AbortSignal): HTMLElement {
		const d = draft!;
		return el("div", { class: "rd-thread rd-draft" }, el("blockquote", { class: "rd-quote" }, d.passage),
			askBox("Ask about this passage…", false, (q, m) => ({ question: q, mode: m, passage: d.passage, ...(d.blockKey ? { blockKey: d.blockKey } : {}) }), () => { draft = null; }, () => { draft = null; render(); }));
	}

	function sidePanel(fallback: DiscussionThread[], signal: AbortSignal): HTMLElement {
		const panel = el("div", { class: "rd-discuss" });
		const d = discussion;
		if (!d) return panel;
		const draftInSide = draft !== null && !(draft.blockKey && renderedBlockKeys(reading!).has(draft.blockKey));
		if (fallback.length === 0 && d.side.exchanges.length === 0 && !draftInSide) panel.append(el("p", { class: "rd-muted" }, "Ask anything about this reading. To ask about one passage, select it in the reading."));
		for (const t of fallback) panel.append(threadCard(t, signal));
		if (draftInSide) panel.append(draftCard(signal));
		for (const x of d.side.exchanges) panel.append(exchangeItem(x, signal));
		panel.append(askBox("Ask about this reading…", d.side.exchanges.some(exchangeIsLive), (q, m) => ({ question: q, mode: m })));
		return panel;
	}

	/** "Ask about this" over a selection inside the reading's content. */
	function passageAsk(content: HTMLElement, signal: AbortSignal) {
		let pop: HTMLElement | null = null;
		const clear = () => {
			pop?.remove();
			pop = null;
		};
		const update = () => {
			clear();
			const sel = document.getSelection();
			if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
			const textSel = sel.toString().replace(/\s+/g, " ").trim();
			if (textSel.length < 3) return;
			const range = sel.getRangeAt(0);
			const elOf = (n: Node | null) => (n instanceof Element ? n : (n?.parentElement ?? null));
			const start = elOf(range.startContainer);
			const end = elOf(range.endContainer);
			if (!start || !end || !content.contains(start) || !content.contains(end)) return;
			if (start.closest(".rd-thread") || end.closest(".rd-thread")) return;
			const blockKey = end.closest<HTMLElement>("[data-discuss-block]")?.dataset.discussBlock;
			const rect = range.getBoundingClientRect();
			const b = el("button", { type: "button", class: "rd-btn" }, "Ask about this");
			pop = el("div", { class: "rd-pop" }, b);
			pop.style.left = `${Math.min(Math.max(rect.left + rect.width / 2, 80), window.innerWidth - 80)}px`;
			pop.style.top = `${Math.max(rect.top - 8, 56)}px`;
			pop.onmousedown = (e) => e.preventDefault();
			b.onclick = () => {
				draft = { passage: textSel.slice(0, 4000), ...(blockKey ? { blockKey } : {}) };
				document.getSelection()?.removeAllRanges();
				clear();
				if (!blockKey && opts.compact) discussOpen = true;
				render();
			};
			document.body.append(pop);
		};
		const onUp = () => setTimeout(update, 0);
		const onSel = () => document.getSelection()?.isCollapsed && clear();
		document.addEventListener("mouseup", onUp);
		document.addEventListener("keyup", onUp);
		document.addEventListener("selectionchange", onSel);
		document.addEventListener("scroll", clear, true);
		signal.addEventListener("abort", () => {
			clear();
			document.removeEventListener("mouseup", onUp);
			document.removeEventListener("keyup", onUp);
			document.removeEventListener("selectionchange", onSel);
			document.removeEventListener("scroll", clear, true);
		});
	}

	/** "On this page" (the Graphite reading TOC), from the article's h2 headings. */
	function toc(article: HTMLElement, signal: AbortSignal): HTMLElement {
		const nav = el("nav", { class: "rd-toc", "aria-label": "On this page" });
		const read = () => {
			const heads = [...article.querySelectorAll<HTMLElement>("h2")].filter((h) => h.textContent?.trim());
			nav.hidden = heads.length < 2;
			nav.replaceChildren(el("span", { class: "rd-label" }, "On this page"), ...heads.map((h) => {
				const b = el("button", { type: "button", class: "rd-link" }, h.textContent ?? "");
				b.onclick = () => h.scrollIntoView({ behavior: "smooth", block: "start" });
				return b;
			}));
		};
		const mo = new MutationObserver(read);
		mo.observe(article, { childList: true, subtree: true });
		signal.addEventListener("abort", () => mo.disconnect());
		queueMicrotask(read);
		return nav;
	}

	const off = api.listen((topic, data) => {
		if (topic === "answer" && data?.readingId === id) {
			live.set(data.exchangeId, { text: data.text, activity: data.activity });
			const n = liveNodes.get(data.exchangeId);
			if (n) {
				n.md?.update({ text: data.text });
				n.activity.textContent = data.activity || "answering";
			}
			return;
		}
		if (topic === "discussion-changed" && data?.readingId === id) return void load();
		if (topic === "readings-changed" && (!data?.id || data.id === id)) return void load();
		if (topic === "session-settled" && reading?.anchor.chatId && data?.chatId === reading.anchor.chatId && reading.sections?.length) return void load();
		if (topic === "resync") void load();
	});
	opts.signal.addEventListener("abort", () => {
		off();
		scope.abort();
		host.remove();
	});
	host.append(el("div", { class: "rd-muted" }, "Loading…"));
	void load();
}
