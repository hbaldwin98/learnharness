"use client";

/** Plugin session side panel host (fork E2): one open panel per session beside
 * the transcript, with host tabs, splitter, close button and persisted width. */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { XIcon } from "lucide-react";
import type { PluginSessionPanel } from "@/src/core";
import { usePlugins } from "@/components/plugins";
import { useForkEntries } from "@/components/plugin-field-accessory";
import { SESSION_PANELS } from "@/components/plugin-fork-context";
import type { ForkEntry } from "@/components/plugin-fork-registry";
import { pluginPanelStore } from "@/components/plugin-panel-store";

type PanelEntry = ForkEntry<Readonly<PluginSessionPanel>>;

export function panelsForSession(entries: readonly PanelEntry[], kind: "teaching" | "practice"): PanelEntry[] {
	return entries.filter(entry => !entry.value.sessions || entry.value.sessions.includes(kind));
}
/** Clamp to the panel minimum and to most of the window. */
export function clampPanelWidth(width: number, minWidth: number, viewport: number): number {
	return Math.round(Math.max(minWidth, Math.min(width, Math.max(minWidth, viewport * 0.7))));
}

export function PluginSessionPanelHost({ sessionId, kind }: { sessionId: string; kind: "teaching" | "practice" }) {
	const { manager } = usePlugins();
	const panels = panelsForSession(useForkEntries<Readonly<PluginSessionPanel>>(manager?.fork, SESSION_PANELS), kind);
	useSyncExternalStore(pluginPanelStore.subscribe, pluginPanelStore.getVersion, () => 0);
	const openKey = pluginPanelStore.openPanel(sessionId);
	const open = panels.find(entry => entry.key === openKey);
	if (!open) return null;
	return <OpenPanel key={`${sessionId}:${open.key}`} sessionId={sessionId} kind={kind} panel={open} tabs={panels} />;
}

function OpenPanel({ sessionId, kind, panel, tabs }: { sessionId: string; kind: "teaching" | "practice"; panel: PanelEntry; tabs: readonly PanelEntry[] }) {
	const { manager } = usePlugins();
	const body = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string>();
	const stored = pluginPanelStore.width(sessionId, panel.key, panel.value.defaultWidth!);
	const [width, setWidth] = useState(() => typeof window === "undefined" ? stored : clampPanelWidth(stored, panel.value.minWidth!, window.innerWidth));
	useEffect(() => {
		if (!manager || !body.current) return;
		return manager.mount(panel.pluginId, (child, signal) => {
			if (!panel.isCurrent()) return;
			return panel.value.mount(child, { sessionId, kind, signal: AbortSignal.any([signal, panel.signal]) });
		}, body.current, setError);
	}, [manager, panel, sessionId, kind]);
	const drag = (event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		const startX = event.clientX, startWidth = width;
		let latest = width;
		const move = (next: PointerEvent) => {
			latest = clampPanelWidth(startWidth + (startX - next.clientX), panel.value.minWidth!, window.innerWidth);
			setWidth(latest);
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			pluginPanelStore.setWidth(sessionId, panel.key, latest);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};
	return (
		<>
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize panel"
				data-testid="plugin-session-panel-splitter"
				onPointerDown={drag}
				className="w-1 shrink-0 cursor-col-resize bg-border/60 transition-colors hover:bg-primary/40"
			/>
			<aside data-testid="plugin-session-panel" data-plugin-panel={panel.key} aria-label={panel.value.title} style={{ width }} className="flex h-full min-h-0 shrink-0 flex-col bg-background">
				<div className="flex h-15 shrink-0 items-center gap-1 border-b border-border px-2">
					<div role="tablist" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
						{tabs.map(tab => (
							<button
								key={tab.key}
								type="button"
								role="tab"
								aria-selected={tab.key === panel.key}
								onClick={() => pluginPanelStore.setOpen(sessionId, tab.key)}
								className={`flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2 font-ui text-xs transition-colors ${tab.key === panel.key ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
							>
								{tab.value.icon && <span aria-hidden="true" className="inline-flex size-4 shrink-0 items-center justify-center [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: tab.value.icon }} />}
								<span className="truncate">{tab.value.title}</span>
							</button>
						))}
					</div>
					<button
						type="button"
						aria-label="Close panel"
						data-testid="plugin-session-panel-close"
						onClick={() => pluginPanelStore.setOpen(sessionId, null)}
						className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<XIcon className="size-4" />
					</button>
				</div>
				{error && <p role="alert" className="px-3 py-2 text-xs text-destructive">{panel.value.title}: {error}</p>}
				<div ref={body} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto" />
			</aside>
		</>
	);
}
