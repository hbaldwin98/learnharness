/**
 * THE AGENT SIDE OF A PRACTICE WORKSPACE MODULE (docs/practice-workspaces.md
 * §3; plan step 1). A module contributes its pose fields to the problem
 * tool's `workspace` union, verifies a pose before it goes through (the
 * "verify, never one-shot" rule — step 2 builds the starter and runs the
 * tests against the reference here), and may add tools to the practice
 * registry. Its doctrine lives in prompts/workspace-<id>/ and composes
 * while the module is available (src/agent/prompt-segments.ts).
 *
 * Which modules are AVAILABLE on a turn is the server's decision
 * (src/server/workspaces.ts) — this layer only receives the list.
 */

import { Type, type TObject, type TSchema } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WorkspaceModuleId } from "../../core/workspaces.ts";

export interface WorkspacePoseContext {
	chatId: string;
	problemCallId: string;
	signal?: AbortSignal;
	/** Live progress lines (e.g. an image build), shown as the pose's activity. */
	onProgress?: (line: string) => void;
}

export interface AgentWorkspaceModule {
	id: WorkspaceModuleId;
	/** The module's pose fields; the registry adds `module: Literal(id)`. */
	poseSchema: TObject;
	/** Pose-time verification. Returns correctable error lines; [] accepts. */
	verifyPose(workspace: unknown, ctx: WorkspacePoseContext): Promise<string[]>;
	/** Module tools added to the practice registry. */
	tools?(ctx: { chatId: string }): Record<string, AgentTool<any>>;
}

/** One module's descriptor schema: its pose fields plus the module literal. */
export function descriptorSchema(module: AgentWorkspaceModule): TObject {
	return Type.Object({
		module: Type.Literal(module.id, { description: `REQUIRED — "${module.id}".` }),
		...module.poseSchema.properties,
	});
}

/** The problem tool's `workspace` field schema, or null when no module is
 *  available (the field is then absent — today's schema, byte-identical). */
export function workspaceFieldSchema(modules: readonly AgentWorkspaceModule[]): TSchema | null {
	if (modules.length === 0) return null;
	const description =
		"OPTIONAL — a workspace for this problem (opens beside the thinking field). OMIT for an ordinary problem.";
	const schemas = modules.map(descriptorSchema);
	return Type.Optional(
		schemas.length === 1 ? { ...schemas[0]!, description } : Type.Union(schemas, { description }),
	);
}

/** Find the available module a descriptor names. */
export function moduleFor(
	modules: readonly AgentWorkspaceModule[],
	id: WorkspaceModuleId,
): AgentWorkspaceModule | undefined {
	return modules.find((m) => m.id === id);
}
