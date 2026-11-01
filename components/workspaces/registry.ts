"use client";

import type { ComponentType } from "react";
import dynamic from "next/dynamic";
import { workspaceOf, type WorkspaceModuleId } from "@/src/core";

/**
 * THE UI SIDE OF A PRACTICE WORKSPACE MODULE (docs/practice-workspaces.md;
 * plan steps 1 and 3): module id → the pane that opens beside the
 * transcript while one of its problems is active. While the pane is open
 * its narration strip is the talk channel and the dock is the problem bar
 * (owner ruling, step 5); hidden, the thinking dock returns. A problem with no workspace, or
 * with a module this build doesn't know, gets no pane — the thinking dock
 * alone, so it can still be worked on or dismissed.
 */

/** The module-neutral props every workspace pane receives. */
export interface WorkspaceProps {
	chatId: string;
	problemCallId: string;
	input: { statement: string };
	/** A turn is running (Submit waits for it to end). */
	busy: boolean;
	/** Tell the agent about the stored Submit (starts its turn). */
	onSubmitted: (problemCallId: string) => void;
	/** Ask the agent (plan step 5): the narration draft, maybe empty; the
	 *  server attaches the trace. Starts its turn. */
	onAsk: (problemCallId: string, text: string) => void;
	/** A lesson's coding exercise (plan step 9): skip it without
	 *  submitting. Absent for practice problems. */
	onSkip?: (problemCallId: string) => void;
	/** Below lg the pane overlays the transcript: back to it. */
	onHide?: () => void;
}

/** Each module's pane, loaded on demand and never prerendered (the editor
 *  is browser-only and heavy). */
export const WORKSPACE_COMPONENTS: Readonly<Record<WorkspaceModuleId, ComponentType<WorkspaceProps>>> = {
	code: dynamic(() => import("./code/code-workspace").then((m) => m.CodeWorkspace), { ssr: false }),
};

/** The pane for a problem, or null for none (no workspace, or a module
 *  this build doesn't know). */
export function workspaceComponentFor(
	problemInput: unknown,
	components: Readonly<Record<WorkspaceModuleId, ComponentType<WorkspaceProps>>> = WORKSPACE_COMPONENTS,
): ComponentType<WorkspaceProps> | null {
	const descriptor = workspaceOf(problemInput);
	if (!descriptor) return null;
	return Object.hasOwn(components, descriptor.module) ? components[descriptor.module]! : null;
}
