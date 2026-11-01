/**
 * PRACTICE WORKSPACES (docs/practice-workspaces.md, owner-ruled
 * 2026-11-01): a practice problem may carry a workspace descriptor — a
 * richer place to work than the thinking field (coding is the first
 * module). A module is one id with a piece in each layer: this pure
 * reader (core), its pose schema + verification + tools (agent,
 * src/agent/workspaces/registry.ts), its availability (server,
 * src/server/workspaces.ts) and its UI (components/workspaces/registry.ts).
 *
 * An ABSENT descriptor IS the thinking field (owner ruling): "thinking"
 * is never written as a module value, so every pre-workspace record reads
 * unchanged with no migration.
 */

/** A workspace module id (e.g. "code"). */
export type WorkspaceModuleId = string;

/** The workspace descriptor riding a problem call's arguments. */
export interface WorkspaceDescriptor {
	module: WorkspaceModuleId;
}

/** Read the descriptor off a problem call's input; null = the thinking field. */
export function workspaceOf(problemInput: unknown): WorkspaceDescriptor | null {
	if (typeof problemInput !== "object" || problemInput === null) return null;
	const workspace = (problemInput as { workspace?: unknown }).workspace;
	if (typeof workspace !== "object" || workspace === null) return null;
	const moduleId = (workspace as { module?: unknown }).module;
	if (typeof moduleId !== "string" || moduleId.length === 0) return null;
	return workspace as WorkspaceDescriptor;
}

/** The prompt-segment directory prefix for a module's doctrine
 *  (owner ruling: `workspace-<id>/NN-x.md`). */
export const WORKSPACE_PROMPT_PREFIX = "workspace-";

/** A module id usable as a prompt directory suffix. */
export const WORKSPACE_ID_RE = /^[a-z][a-z0-9-]*$/;
