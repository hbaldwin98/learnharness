import type { ComponentType } from "react";
import { workspaceOf, type WorkspaceModuleId } from "@/src/core";

/**
 * THE UI SIDE OF A PRACTICE WORKSPACE MODULE (docs/practice-workspaces.md;
 * plan step 1): module id → the component that replaces the practice
 * dock's thinking field while one of its problems is active. Empty until
 * step 3 registers the coding workspace.
 */

/** The module-neutral props every workspace receives (the shared part of
 *  PracticeDockProps); later steps add their own channels. */
export interface WorkspaceProps {
	problemCallId: string;
	input: { statement: string };
	expanded: boolean;
	onExpand: () => void;
	onEscape?: () => void;
	compactionRunning?: boolean;
}

export const WORKSPACE_COMPONENTS: Readonly<Record<WorkspaceModuleId, ComponentType<WorkspaceProps>>> = {};

/** The workspace component for a problem, or null for the thinking dock —
 *  no workspace, or a module this build doesn't know (owner ruling: an
 *  unknown module falls back to the thinking dock, so the problem can
 *  still be worked on or dismissed). */
export function workspaceComponentFor(
	problemInput: unknown,
	components: Readonly<Record<WorkspaceModuleId, ComponentType<WorkspaceProps>>> = WORKSPACE_COMPONENTS,
): ComponentType<WorkspaceProps> | null {
	const descriptor = workspaceOf(problemInput);
	if (!descriptor) return null;
	return Object.hasOwn(components, descriptor.module) ? components[descriptor.module]! : null;
}
