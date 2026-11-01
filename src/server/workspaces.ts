/**
 * WHICH PRACTICE WORKSPACE MODULES ARE AVAILABLE (docs/practice-workspaces.md;
 * plan steps 1–2). The server owns the decision: the coding module is
 * registered while Docker is INSTALLED (its schema field and doctrine
 * reach the agent); whether Docker is RUNNING is checked at pose time,
 * where a stopped Docker refuses the pose with "start Docker Desktop".
 *
 * Also the container lifecycle hooks that need the record: at startup
 * (the first time Docker is seen running) every workspace container is
 * reaped; after a practice turn settles or a problem is dismissed, the
 * chat's containers other than its active coding problem are removed.
 */

import { activeProblemOf, type LhMessage } from "../core/native-messages.ts";
import { workspaceOf } from "../core/workspaces.ts";
import type { AgentWorkspaceModule } from "../agent/workspaces/registry.ts";
import { CODE_MODULE_ID, createCodeModule } from "../agent/workspaces/code/module.ts";
import type { DockerStatus } from "../agent/workspaces/code/runner.ts";
import { createDockerRunner } from "./workspaces/docker-runner.ts";

type DockerRunner = ReturnType<typeof createDockerRunner>;

/** Process-wide state on globalThis: Next can load this module in more
 *  than one entry, and there must be one runner (builds, locks, idle
 *  sweep) per process. */
interface WorkspaceState {
	runner: DockerRunner;
	code: AgentWorkspaceModule;
	status: DockerStatus | null;
	reaped: boolean;
}
const STATE_KEY = Symbol.for("learnharness.workspaces");
function state(): WorkspaceState {
	const g = globalThis as unknown as Record<symbol, WorkspaceState | undefined>;
	let s = g[STATE_KEY];
	if (!s) {
		const runner = createDockerRunner();
		s = { runner, code: createCodeModule(runner), status: null, reaped: false };
		g[STATE_KEY] = s;
	}
	return s;
}

/** Refresh Docker's status (cached 30 s by the runner); reap leftover
 *  containers the first time Docker is seen running. Never throws. */
export async function refreshWorkspaceAvailability(): Promise<void> {
	const s = state();
	try {
		s.status = await s.runner.status();
		if (s.status === "running" && !s.reaped) {
			s.reaped = true;
			await s.runner.reapAll();
		}
	} catch {
		s.status = s.status ?? "missing";
	}
}

/** The modules available to a practice turn (from the last refresh). */
export function availableWorkspaceModules(): readonly AgentWorkspaceModule[] {
	const s = state();
	return s.status !== null && s.status !== "missing" ? [s.code] : [];
}

/** Remove the chat's workspace containers except its active coding
 *  problem's (conclude and dismissal both end here). Fire-and-forget. */
export function reconcileWorkspaces(chatId: string, messages: readonly LhMessage[]): void {
	const s = state();
	if (s.status !== "running") return;
	const active = activeProblemOf(messages);
	const keep = active && workspaceOf(active.input)?.module === CODE_MODULE_ID ? active.toolCallId : null;
	void s.runner.retainOnly(chatId, keep).catch(() => {});
}
