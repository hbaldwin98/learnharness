/** Plugin tools that hide their turn's assistant text (fork extension E7).
 * Presentation only: the model context and the saved record are unchanged. */
import { isSideQuestionMarker, type LhMessage } from "./native-messages.ts";

/** Host flag persisted into a listed tool's successful result details. */
export const PLUGIN_HIDES_TURN_TEXT_KEY = "lhHidesTurnText";

export interface PluginHiddenTurnTextTools {
	/** Names of tools from this registration whose SUCCESSFUL call hides the
	 * learner-visible text of the assistant message containing the call and of
	 * the next assistant message when that one is text-only. Reasoning and tool
	 * cards still render. Listed tools must return object (or absent) `details`;
	 * the host adds its flag there. */
	hidesTurnText?: string[];
}

export function validateHidesTurnText(value: unknown): ReadonlySet<string> | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some(name => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name))) throw new Error("Plugin tools hidesTurnText must be a list of native tool names");
	return new Set(value as string[]);
}

/** Add the host flag to a successful tool output; non-object details stay unflagged. */
export function markHidesTurnText<T extends { details?: unknown }>(output: T): T {
	const details = output?.details;
	if (details !== undefined && details !== null && (typeof details !== "object" || Array.isArray(details))) return output;
	return { ...output, details: { ...(details as object | null | undefined ?? {}), [PLUGIN_HIDES_TURN_TEXT_KEY]: true } };
}

/** Assistant message ids whose text blocks are hidden. */
export function hiddenTurnTextIds(messages: readonly LhMessage[]): Set<string> {
	const flagged = new Set<string>();
	for (const m of messages) {
		if (m.role === "toolResult" && !m.isError && (m.details as Record<string, unknown> | null | undefined)?.[PLUGIN_HIDES_TURN_TEXT_KEY] === true) flagged.add(m.toolCallId);
	}
	const hidden = new Set<string>();
	if (!flagged.size) return hidden;
	let carry = false;
	for (const m of messages) {
		// Tool results and tail-neutral markers never break the turn.
		if (m.role === "toolResult" || isSideQuestionMarker(m)) continue;
		if (m.role !== "assistant") { carry = false; continue; }
		const calls = m.content.filter(block => block.type === "toolCall");
		if (calls.some(call => flagged.has(call.id))) { hidden.add(m.id); carry = true; continue; }
		if (carry && calls.length === 0) hidden.add(m.id);
		carry = false;
	}
	return hidden;
}
