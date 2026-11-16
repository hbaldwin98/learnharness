import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { anchorOf, MAX_ANNOTATION_CHARS, reanchor } from "../shared/annotations.ts";
import type { FileNote } from "../shared/protocol.ts";
import { resolveInside } from "./project-files.ts";

const MAX_LIVE = 40;
const KEEP_OUTDATED = 20;

/**
 * Tutor notes pinned to lines of files in a project (the project form of `annotate`).
 * Each read re-anchors notes against the file's current text: moved lines carry the
 * note, deleted lines (or a deleted file) make it outdated. Learners can dismiss notes.
 */
export function createFileNotes(directory: string) {
	const fileOf = (projectId: string) => path.join(directory, `${projectId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
	const load = (projectId: string): FileNote[] => {
		try { const raw = JSON.parse(fs.readFileSync(fileOf(projectId), "utf8")); return Array.isArray(raw) ? raw : []; } catch { return []; }
	};
	const save = (projectId: string, notes: FileNote[]) => {
		const live = notes.filter(n => !n.outdated);
		const outdated = notes.filter(n => n.outdated).slice(-KEEP_OUTDATED);
		fs.mkdirSync(directory, { recursive: true });
		const temp = `${fileOf(projectId)}.${process.pid}.tmp`;
		fs.writeFileSync(temp, JSON.stringify([...outdated, ...live]));
		fs.renameSync(temp, fileOf(projectId));
	};
	const read = (root: string, relative: string): string | null => {
		try { return fs.readFileSync(resolveInside(root, relative), "utf8"); } catch { return null; }
	};

	return {
		/** All notes, re-anchored against the files as they are now (persisted when anything moved). */
		list(projectId: string, root: string): FileNote[] {
			const notes = load(projectId);
			const contents = new Map<string, string | null>();
			let changed = false;
			const next = notes.map(note => {
				if (note.outdated) return note;
				if (!contents.has(note.path)) contents.set(note.path, read(root, note.path));
				const content = contents.get(note.path);
				const moved: FileNote = content === null || content === undefined ? { ...note, outdated: true } : { ...note, ...reanchor(note, content) };
				if (moved.line !== note.line || moved.outdated !== note.outdated) changed = true;
				return moved;
			});
			if (changed) save(projectId, next);
			return next;
		},

		add(projectId: string, root: string, input: { chatId: string; path: string; line: number; endLine?: number; note: string; now?: Date }): FileNote {
			const relative = input.path.replace(/\\/g, "/").replace(/^\/work\//, "").replace(/^(\.\/)+/, "");
			const content = read(root, relative);
			if (content === null) throw new Error(`${relative} does not exist in the project`);
			const lines = content.split("\n").length;
			const endLine = input.endLine ?? input.line;
			if (input.line < 1 || input.line > lines) throw new Error(`line must be between 1 and ${lines}`);
			if (endLine < input.line || endLine > lines) throw new Error(`endLine must be between line and ${lines}`);
			const note = input.note.trim();
			if (!note) throw new Error("note must be non-empty");
			if (note.length > MAX_ANNOTATION_CHARS) throw new Error(`note must be at most ${MAX_ANNOTATION_CHARS} characters`);
			const notes = this.list(projectId, root);
			if (notes.filter(n => !n.outdated).length >= MAX_LIVE) throw new Error(`at most ${MAX_LIVE} live notes; the learner can dismiss old ones`);
			const created: FileNote = { id: randomUUID(), chatId: input.chatId, path: relative, line: input.line, endLine, note, at: (input.now ?? new Date()).toISOString(), anchor: anchorOf(content, input.line, endLine) };
			save(projectId, [...notes, created]);
			return created;
		},

		dismiss(projectId: string, id: string): void {
			save(projectId, load(projectId).filter(n => n.id !== id));
		},

		forget(projectId: string) { fs.rmSync(fileOf(projectId), { force: true }); },
	};
}

export type FileNotes = ReturnType<typeof createFileNotes>;
