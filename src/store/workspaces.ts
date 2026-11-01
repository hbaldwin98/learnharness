/**
 * WorkspaceStore — the fs JSON adapter for practice coding workspaces
 * (plan step 3): one file per problem at
 * data/workspaces/<chatId>/<problem file id>.json holding the learner's
 * live files and the last Run/Submit results. Sync fs with temp-file
 * rename, like the other stores; the problem call id is encoded into a
 * safe filename. Deleted with the chat's folder when a session goes.
 *
 * Schema stamp: a record stamped NEWER than this build is refused on read
 * and never rewritten.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { CodeFile, WorkspaceRunResult } from "../core/contracts/workspaces.ts";

export const CURRENT_WORKSPACE_VERSION = 1;

export interface StoredRun {
	files: CodeFile[];
	result: WorkspaceRunResult;
}

export interface WorkspaceRecord {
	version: number;
	chatId: string;
	problemCallId: string;
	files: CodeFile[];
	updatedAt: string;
	lastRun?: StoredRun;
	lastSubmit?: StoredRun;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function chatDir(chatId: string): string {
	if (!SAFE_ID.test(chatId)) throw new Error(`Invalid chat id: ${chatId}`);
	return path.join(PATHS.data, "workspaces", chatId);
}

/** A filesystem-safe, collision-free name for a tool call id. */
function problemFile(chatId: string, problemCallId: string): string {
	const readable = problemCallId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);
	const hash = createHash("sha256").update(problemCallId).digest("hex").slice(0, 10);
	return path.join(chatDir(chatId), `${readable}-${hash}.json`);
}

export function getWorkspace(chatId: string, problemCallId: string): WorkspaceRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(problemFile(chatId, problemCallId), "utf-8"));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as WorkspaceRecord;
	if (typeof record.version === "number" && record.version > CURRENT_WORKSPACE_VERSION) {
		console.error(`[workspace ${chatId}/${problemCallId}] stamped with schema version ${record.version} > ${CURRENT_WORKSPACE_VERSION} — refusing to read it`);
		return null;
	}
	if (!Array.isArray(record.files) || record.problemCallId !== problemCallId) return null;
	return record;
}

/** Read-modify-write (no awaits inside: atomic within the event loop). */
export function mutateWorkspace(
	chatId: string,
	problemCallId: string,
	starter: () => CodeFile[],
	mutate: (record: WorkspaceRecord) => WorkspaceRecord,
): WorkspaceRecord {
	const file = problemFile(chatId, problemCallId);
	const existing = getWorkspace(chatId, problemCallId);
	const base: WorkspaceRecord = existing ?? {
		version: CURRENT_WORKSPACE_VERSION,
		chatId,
		problemCallId,
		files: starter(),
		updatedAt: new Date().toISOString(),
	};
	const next = { ...mutate(base), version: CURRENT_WORKSPACE_VERSION, updatedAt: new Date().toISOString() };
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(next, null, "\t"), "utf-8");
	fs.renameSync(tmp, file);
	return next;
}

/** Remove every workspace of a chat (session deletion). */
export function deleteChatWorkspaces(chatId: string): void {
	try {
		fs.rmSync(chatDir(chatId), { recursive: true, force: true });
	} catch {
		// invalid id or already gone
	}
}
