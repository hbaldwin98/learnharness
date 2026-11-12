/** Richer contextual action placements (fork extension E5). Browser-safe types and
 * limits; the host owns the popover, capture and invocation. */

/** UTF-8 byte cap on selected text. Longer selections show a disabled
 * "Shorten selection" button instead of running the action. */
export const PLUGIN_SELECTION_TEXT_LIMIT = 4096;

/** One tutor-message text selection, captured when the action is clicked. */
export interface PluginTranscriptSelection {
	/** Selected rendered text, at most PLUGIN_SELECTION_TEXT_LIMIT UTF-8 bytes. */
	readonly text: string;
	/** Native id of the persisted tutor message containing the selection. */
	readonly messageId: string;
	/** Content part index within that message, when the host can resolve it. */
	readonly partIndex?: number;
}
/** Invoked from the host selection popover over a session transcript. The
 * surface is "transcript", not "session": it carries no whole-session `view`. */
export interface PluginTranscriptSelectionActionContext {
	placement: "transcript-selection";
	surface: "transcript";
	sessionId: string;
	kind: "teaching" | "practice";
	selection: PluginTranscriptSelection;
}
/** Place an action in the transcript selection popover of every session. */
export interface PluginTranscriptSelectionPlacement {
	id: string;
	actionId: string;
	location: "transcript-selection";
}

export function selectionTextBytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** Invoked from the Chains toolbar (`surface: "chains"`) or the graph's selected
 * node card (`surface: "graph"`). Chains pick mode supplies the ticked nodes in
 * tick order; browse mode supplies every node currently shown. The node card
 * supplies its one node. `chainIds` are the chains containing any of them. */
export interface PluginGraphSelectionActionContext {
	placement: "graph-selection";
	surface: "graph" | "chains";
	nodeIds: readonly string[];
	chainIds: readonly string[];
}
export interface PluginGraphSelectionPlacement {
	id: string;
	actionId: string;
	location: "graph-selection";
}
/** Ids of chains with any member (premise or conclusion) in nodeIds. */
export function chainIdsContaining(nodeIds: readonly string[], chains: readonly { id: string; premises: readonly string[]; conclusion: string }[]): string[] {
	const wanted = new Set(nodeIds);
	return chains.filter(chain => wanted.has(chain.conclusion) || chain.premises.some(id => wanted.has(id))).map(chain => chain.id);
}
