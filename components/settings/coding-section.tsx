"use client";

/**
 * SETTINGS → CODING (practice workspaces, plan step 6): the coding
 * workspace's own section (owner ruling: its own section, not a row in the
 * Tools list, whose toggles filter the teaching registry only). Step 6
 * brings the Listening switch; step 8 adds the default language, Docker
 * status and image management.
 */

import type { AgentSettings } from "@/src/core";
import { SettingsRow, Toggle } from "./controls.tsx";

/** Compose the listening switch into the agent section (absent = ON; the
 *  write is explicit either way). Pure — exported for tests. */
export function composeListening(agent: AgentSettings | undefined, on: boolean): AgentSettings {
	return { ...agent, listening: { enabled: on } };
}

export function CodingSection({
	agent,
	onAgentChange,
}: {
	agent: AgentSettings | undefined;
	onAgentChange: (next: AgentSettings) => void;
}) {
	const on = agent?.listening?.enabled ?? true;
	return (
		<SettingsRow
			label="Listening"
			hint="While you work a coding problem, the agent looks in after a Run, a quiet stretch, every few minutes, or when you sound stuck — and speaks only if it helps. Each look is a model turn."
			testid="coding-listening-row"
		>
			<Toggle checked={on} label="listening" onChange={(next) => onAgentChange(composeListening(agent, next))} />
		</SettingsRow>
	);
}
