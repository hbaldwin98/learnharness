"use client";

/** Plugin transcript markers (fork E1): the registered renderer for the marker's
 * (pluginId, typeId), or a muted fallback when none is live. */
import { useEffect, useRef, useState } from "react";
import { readPluginMarkerDetails, type PluginMarkerRenderer } from "@/src/core";
import { usePlugins } from "@/components/plugins";
import { useForkEntries } from "@/components/plugin-field-accessory";
import { MARKER_RENDERERS } from "@/components/plugin-fork-context";
import type { ForkEntry } from "@/components/plugin-fork-registry";

export function PluginMarkerPart({ data, messageId, sessionId }: { data: unknown; messageId: string; sessionId: string }) {
	const { manager } = usePlugins();
	const details = readPluginMarkerDetails(data);
	const key = details ? `${details.pluginId}/${details.typeId}` : "";
	const entries = useForkEntries<Readonly<PluginMarkerRenderer>>(manager?.fork, MARKER_RENDERERS);
	const entry: ForkEntry<Readonly<PluginMarkerRenderer>> | undefined = entries.find(item => item.key === key);
	const container = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string>();
	useEffect(() => {
		setError(undefined);
		if (!manager || !entry || !container.current || !details) return;
		const detached = structuredClone(details.data);
		return manager.mount(entry.pluginId, (child, signal) => {
			if (!entry.isCurrent()) return;
			return entry.value.mount(child, { details: detached, messageId, sessionId, signal: AbortSignal.any([signal, entry.signal]) });
		}, container.current, setError);
		// details identity follows the record message; key/entry select the renderer.
	}, [manager, entry, messageId, sessionId, key]);
	if (!details) return null;
	if (!entry || error) {
		return (
			<div data-testid="plugin-marker-fallback" data-plugin-marker={key} className="my-2 font-ui text-xs text-muted-foreground">
				Plugin content ({details.pluginId})
			</div>
		);
	}
	return <div ref={container} data-testid="plugin-marker" data-plugin-marker={key} className="my-2 flex min-w-0 flex-col" />;
}
