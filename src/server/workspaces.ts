/**
 * WHICH PRACTICE WORKSPACE MODULES ARE AVAILABLE (docs/practice-workspaces.md;
 * plan step 1). The server owns the decision — step 2 makes the coding
 * module Docker-aware (installed → available; not running → its pose is
 * refused with "start Docker"). Step 1 registers no modules, so practice
 * composes exactly as before.
 */

import type { AgentWorkspaceModule } from "../agent/workspaces/registry.ts";

/** The modules available to a practice turn. */
export function availableWorkspaceModules(): readonly AgentWorkspaceModule[] {
	return [];
}
