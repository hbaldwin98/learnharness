"use client";

/** Plugin actions in the host transcript selection popover (fork E5). Placed
 * `transcript-selection` actions become ordinary SelectionToolbar buttons; the
 * context is captured from the selection at click time. */
import { useMemo } from "react";
import type { LucideIcon } from "lucide-react";
import { PuzzleIcon } from "lucide-react";
import { PLUGIN_SELECTION_TEXT_LIMIT, selectionTextBytes, type PluginAction, type PluginTranscriptSelectionActionContext } from "@/src/core";
import { usePlugins } from "@/components/plugins";
import { placedPluginActions, pluginActionDisabled, type PlacedPluginAction } from "@/components/plugin-chrome";
import type { SelectionAction } from "@/components/selection-toolbar";
import type { CapturedSelection } from "@/components/selection-text";

const PROBE: PluginTranscriptSelectionActionContext = { placement: "transcript-selection", surface: "transcript", sessionId: "", kind: "teaching", selection: { text: "", messageId: "" } };

function svgIcon(action: PluginAction): LucideIcon {
	if (!action.icon) return PuzzleIcon;
	const markup = action.icon;
	const Icon = ({ className }: { className?: string }) =>
		<span aria-hidden="true" className={`inline-flex items-center justify-center [&>svg]:size-full ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: markup }} />;
	return Icon as unknown as LucideIcon;
}

export function transcriptSelectionContext(sessionId: string, kind: "teaching" | "practice", capture: CapturedSelection): PluginTranscriptSelectionActionContext {
	return Object.freeze({ placement: "transcript-selection", surface: "transcript", sessionId, kind,
		selection: Object.freeze({ text: capture.selector.text, messageId: capture.messageId }) });
}

export function pluginSelectionActions(items: readonly PlacedPluginAction[], sessionId: string, kind: "teaching" | "practice",
	run: (item: PlacedPluginAction, context: PluginTranscriptSelectionActionContext) => void): SelectionAction[] {
	return items.map(item => ({
		id: `plugin:${item.key}`,
		label: item.action.name,
		ariaLabel: item.action.name,
		icon: svgIcon(item.action),
		disabledLabel: capture => selectionTextBytes(capture.selector.text) > PLUGIN_SELECTION_TEXT_LIMIT ? "Shorten selection" : null,
		visible: capture => !item.busy && !pluginActionDisabled(item.action, transcriptSelectionContext(sessionId, kind, capture)),
		onSelect: capture => { run(item, transcriptSelectionContext(sessionId, kind, capture)); return true; },
	}));
}

export function usePluginSelectionActions(sessionId: string, kind: "teaching" | "practice"): SelectionAction[] {
	const { manager, snapshot } = usePlugins();
	return useMemo(() => pluginSelectionActions(placedPluginActions(snapshot.plugins, PROBE), sessionId, kind,
		(item, context) => { void manager?.runAction(item.pluginId, item.action, context); }), [manager, snapshot.plugins, sessionId, kind]);
}
