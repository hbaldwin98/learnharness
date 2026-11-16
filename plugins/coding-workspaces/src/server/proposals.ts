import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { lineDiff } from "../shared/line-diff.ts";
import type { EditProposal } from "../shared/protocol.ts";
import { resolveInside } from "./project-files.ts";

const MAX_CONTENT = 256 * 1024;
const KEEP_DECIDED = 20;

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export interface Replacement { find: string; replace: string }

/** Apply exact-match replacements (each `find` must occur exactly once). */
export function applyReplacements(content: string, replacements: Replacement[]): string {
	let out = content;
	for (const [i, r] of replacements.entries()) {
		if (!r.find) throw new Error(`replacement ${i + 1}: find is empty`);
		const first = out.indexOf(r.find);
		if (first === -1) throw new Error(`replacement ${i + 1}: text not found in the file`);
		if (out.indexOf(r.find, first + 1) !== -1) throw new Error(`replacement ${i + 1}: text occurs more than once; include more context`);
		out = out.slice(0, first) + r.replace + out.slice(first + r.find.length);
	}
	return out;
}

/**
 * Tutor-proposed file changes awaiting the learner. A proposal records the file's
 * content hash when proposed; accepting it fails (stale) if the learner has since
 * changed the file. Nothing touches the folder until the learner accepts.
 */
export function createProposals(directory: string) {
	const fileOf = (projectId: string) => path.join(directory, `${projectId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
	const load = (projectId: string): EditProposal[] => {
		try { const raw = JSON.parse(fs.readFileSync(fileOf(projectId), "utf8")); return Array.isArray(raw) ? raw : []; } catch { return []; }
	};
	const save = (projectId: string, list: EditProposal[]) => {
		const pending = list.filter(p => p.status === "pending");
		const decided = list.filter(p => p.status !== "pending").slice(-KEEP_DECIDED);
		fs.mkdirSync(directory, { recursive: true });
		const temp = `${fileOf(projectId)}.${process.pid}.tmp`;
		fs.writeFileSync(temp, JSON.stringify([...decided, ...pending]));
		fs.renameSync(temp, fileOf(projectId));
	};
	const current = (root: string, relative: string): string | null => {
		const file = resolveInside(root, relative);
		return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
	};

	return {
		pending: (projectId: string) => load(projectId).filter(p => p.status === "pending"),
		get: (projectId: string, id: string) => load(projectId).find(p => p.id === id) ?? null,

		propose(input: { projectId: string; root: string; chatId: string; path: string; explanation: string; content?: string; replacements?: Replacement[]; now?: Date }): EditProposal {
			const relative = input.path.replace(/\\/g, "/").replace(/^\/work\//, "").replace(/^(\.\/)+/, "");
			const before = current(input.root, relative);
			let after: string;
			if (input.replacements?.length) {
				if (before === null) throw new Error("The file does not exist; propose its full content instead");
				after = applyReplacements(before, input.replacements);
			} else if (input.content !== undefined) after = input.content;
			else throw new Error("Give either content (the whole new file) or replacements");
			if (after.length > MAX_CONTENT) throw new Error("The proposed file is too large");
			if (before === after) throw new Error("The proposal changes nothing");
			const proposal: EditProposal = {
				id: randomUUID(),
				chatId: input.chatId,
				path: relative,
				explanation: input.explanation.trim(),
				baseHash: before === null ? null : hash(before),
				content: after,
				diff: lineDiff(before ?? "", after) ?? after,
				at: (input.now ?? new Date()).toISOString(),
				status: "pending",
			};
			save(input.projectId, [...load(input.projectId), proposal]);
			return proposal;
		},

		/** Accept (write the file) or reject. A file changed since the proposal makes it stale. */
		decide(projectId: string, root: string, id: string, accept: boolean): EditProposal {
			const list = load(projectId);
			const proposal = list.find(p => p.id === id);
			if (!proposal) throw new Error("Unknown proposal");
			if (proposal.status !== "pending") throw new Error(`That proposal was already ${proposal.status}`);
			if (accept) {
				const before = current(root, proposal.path);
				const base = before === null ? null : hash(before);
				if (base !== proposal.baseHash) {
					proposal.status = "stale";
					save(projectId, list);
					return proposal;
				}
				const file = resolveInside(root, proposal.path);
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, proposal.content);
				proposal.status = "accepted";
			} else proposal.status = "rejected";
			save(projectId, list);
			return proposal;
		},

		forget(projectId: string) { fs.rmSync(fileOf(projectId), { force: true }); },
	};
}

export type Proposals = ReturnType<typeof createProposals>;
