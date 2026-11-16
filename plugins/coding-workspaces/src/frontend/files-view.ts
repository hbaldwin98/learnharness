import type { PluginFrontendContext } from "learnharness-plugin-api";
import { OPS, type FileNote, type ProjectFileView } from "../shared/protocol.ts";

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = doc.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export interface FilesView {
	element: HTMLElement;
	/** New notes (re-render the open file's markers and the notes list). */
	setNotes(notes: FileNote[]): void;
	/** Refresh the file list and the open file (after changes). */
	refresh(): void;
	open(path: string, line?: number): void;
}

/**
 * Read-only browsing of the attached project: a file list (folders collapsible), a
 * viewer with line numbers that highlights the tutor's notes, and the notes list.
 * The learner edits in their own editor; this view follows the folder.
 */
export function createFilesView(ctx: PluginFrontendContext, doc: Document, chatId: string, onDismiss: (id: string) => void): FilesView {
	const root = el(doc, "div", "lh-cw-files");
	const notesHeading = el(doc, "h3", "lh-cw__heading", "Notes from the tutor");
	const notesList = el(doc, "ul", "lh-cw__annotations");
	const toggle = el(doc, "button", "lh-cw-files__toggle", "▸ Files");
	toggle.type = "button";
	const browser = el(doc, "div", "lh-cw-files__browser");
	browser.hidden = true;
	const tree = el(doc, "ul", "lh-cw-files__tree");
	const viewerTitle = el(doc, "div", "lh-cw-files__title");
	const viewer = el(doc, "div", "lh-cw-files__viewer");
	browser.append(tree, viewerTitle, viewer);
	root.append(notesHeading, notesList, toggle, browser);

	let files: string[] = [];
	let notes: FileNote[] = [];
	let openFile: ProjectFileView | null = null;
	let focusLine: number | null = null;
	const collapsed = new Set<string>();

	toggle.addEventListener("click", () => {
		browser.hidden = !browser.hidden;
		toggle.textContent = `${browser.hidden ? "▸" : "▾"} Files`;
		if (!browser.hidden) loadFiles();
	});

	function loadFiles() {
		void ctx.call<{ files: string[]; truncated: boolean }>(OPS.projectFiles, { chatId }).then(r => { files = r.files; renderTree(r.truncated); }).catch(() => {});
	}

	function renderTree(truncated = false) {
		const items: HTMLElement[] = [];
		const seenDirs = new Set<string>();
		for (const file of files) {
			const parts = file.split("/");
			// Folder rows down to the first collapsed folder; the file only when none is collapsed.
			let hidden = false;
			for (let i = 0; i < parts.length - 1 && !hidden; i++) {
				const dir = parts.slice(0, i + 1).join("/");
				if (collapsed.has(dir)) hidden = true;
				if (seenDirs.has(dir)) continue;
				seenDirs.add(dir);
				const li = el(doc, "li", "lh-cw-files__dir");
				li.style.paddingLeft = `${i * 0.75}rem`;
				const b = el(doc, "button", undefined, `${collapsed.has(dir) ? "▸" : "▾"} ${parts[i]}/`);
				b.type = "button";
				b.addEventListener("click", () => { if (collapsed.has(dir)) collapsed.delete(dir); else collapsed.add(dir); renderTree(); });
				li.append(b);
				items.push(li);
			}
			if (hidden) continue;
			const li = el(doc, "li", "lh-cw-files__file");
			li.style.paddingLeft = `${(parts.length - 1) * 0.75}rem`;
			const b = el(doc, "button", undefined, parts.at(-1));
			b.type = "button";
			if (openFile?.path === file) b.setAttribute("aria-current", "true");
			const count = notes.filter(n => n.path === file && !n.outdated).length;
			if (count) b.append(el(doc, "span", "lh-cw-files__badge", ` ${count}`));
			b.addEventListener("click", () => view.open(file));
			li.append(b);
			items.push(li);
		}
		if (truncated) items.push(el(doc, "li", "lh-cw__time", "… more files not listed"));
		tree.replaceChildren(...(items.length ? items : [el(doc, "li", "lh-cw__empty", "No files yet")]));
	}

	function renderViewer() {
		if (!openFile) { viewerTitle.replaceChildren(); viewer.replaceChildren(); return; }
		viewerTitle.replaceChildren(el(doc, "code", undefined, openFile.path), ...(openFile.truncated ? [el(doc, "span", "lh-cw__time", ` (first ${openFile.content.length} of ${openFile.size} bytes)`)] : []));
		const fileNotes = notes.filter(n => n.path === openFile!.path && !n.outdated);
		const pre = el(doc, "pre", "lh-cw-files__code");
		const lines = openFile.content.split("\n");
		const width = String(lines.length).length;
		lines.forEach((text, i) => {
			const n = i + 1;
			const row = el(doc, "div", "lh-cw-files__line");
			if (fileNotes.some(note => n >= note.line && n <= note.endLine)) row.classList.add("lh-cw-files__line--noted");
			if (focusLine === n) row.classList.add("lh-cw-files__line--focus");
			row.append(el(doc, "span", "lh-cw-files__num", String(n).padStart(width)), el(doc, "span", undefined, text || " "));
			pre.append(row);
			for (const note of fileNotes.filter(note => note.endLine === n)) pre.append(el(doc, "div", "lh-cw-files__note", note.note));
		});
		viewer.replaceChildren(pre);
		if (focusLine) pre.children[Math.max(0, focusLine - 1)]?.scrollIntoView?.({ block: "center" });
	}

	function renderNotes() {
		const live = notes.filter(n => !n.outdated);
		const outdated = notes.filter(n => n.outdated);
		notesHeading.hidden = notesList.hidden = notes.length === 0;
		const item = (n: FileNote) => {
			const li = el(doc, "li", n.outdated ? "lh-cw-files__outdated" : undefined);
			const where = el(doc, "button", "lh-cw__lines", `${n.path}:${n.line}${n.endLine > n.line ? `–${n.endLine}` : ""}${n.outdated ? " (outdated)" : ""}`);
			where.type = "button";
			where.disabled = Boolean(n.outdated);
			where.addEventListener("click", () => view.open(n.path, n.line));
			const dismiss = el(doc, "button", "lh-cw-files__dismiss", "×");
			dismiss.type = "button";
			dismiss.title = "Dismiss this note";
			dismiss.addEventListener("click", () => onDismiss(n.id));
			li.append(where, el(doc, "span", undefined, n.note), dismiss);
			return li;
		};
		notesList.replaceChildren(...live.map(item), ...outdated.map(item));
	}

	const view: FilesView = {
		element: root,
		setNotes(next) {
			notes = next;
			renderNotes();
			if (!browser.hidden) { renderTree(); renderViewer(); }
		},
		refresh() {
			if (browser.hidden) return;
			loadFiles();
			if (openFile) view.open(openFile.path, focusLine ?? undefined);
		},
		open(path, line) {
			if (browser.hidden) { browser.hidden = false; toggle.textContent = "▾ Files"; loadFiles(); }
			focusLine = line ?? null;
			void ctx.call<ProjectFileView>(OPS.projectReadFile, { chatId, path })
				.then(file => { openFile = file; renderViewer(); renderTree(); })
				.catch(error => { openFile = null; viewer.replaceChildren(el(doc, "p", "lh-cw-project__error", error instanceof Error ? error.message : String(error))); });
		},
	};
	return view;
}
