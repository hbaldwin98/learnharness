/** Session side panels (fork extension E2): plugin bodies beside the transcript.
 * The host owns layout, splitter, tabs, close button and persistence. */
import type { PluginCleanup } from "./plugins.ts";

export const PLUGIN_PANEL_DEFAULT_WIDTH = 360;
export const PLUGIN_PANEL_MIN_WIDTH = 240;

export interface PluginSessionPanelContext {
	readonly sessionId: string;
	readonly kind: "teaching" | "practice";
	/** Aborted when the session view is left, the panel is closed or switched,
	 * the panel is unregistered or the plugin is disabled. Turns and streaming
	 * do not remount the panel. */
	readonly signal: AbortSignal;
}
export interface PluginSessionPanel {
	/** Route-safe id, unique within this plugin. */
	id: string;
	/** Tab label and accessible name. */
	title: string;
	/** Trusted plugin SVG markup for the tab. */
	icon?: string;
	/** Session kinds offering this panel; omitted means both. */
	sessions?: ("teaching" | "practice")[];
	/** Initial width in CSS px (default 360). The learner's resize persists per session and panel. */
	defaultWidth?: number;
	/** Smallest resize width in CSS px (default 240). */
	minWidth?: number;
	/** Mount the panel body; return sync/async cleanup. */
	mount(container: HTMLElement, context: PluginSessionPanelContext): void | PluginCleanup | Promise<void | PluginCleanup>;
}
export interface PluginPanelsFrontendContext {
	/** Offer a panel beside session transcripts. One panel is open at a time per
	 * session; several offered panels show as host tabs. Invalid/duplicate ids
	 * throw. Returns unregister, which closes and aborts its mounts. */
	registerSessionPanel(panel: PluginSessionPanel): () => void;
}
export interface PluginPanelsAppContext {
	/** Open this plugin's panel for a session (persisted, so it also applies when
	 * that session is viewed later). Replaces any other open panel there. */
	openSessionPanel(sessionId: string, panelId: string): void;
	/** Close whichever panel is open for the session. */
	closeSessionPanel(sessionId: string): void;
}

export function preparePluginSessionPanel(panel: PluginSessionPanel): Readonly<PluginSessionPanel> {
	if (!panel || typeof panel !== "object") throw new Error("Session panel must be an object");
	if (typeof panel.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(panel.id)) throw new Error("Session panel id must be a route-safe string of 1–128 characters");
	if (typeof panel.title !== "string" || !panel.title.trim()) throw new Error("Session panel title must be a nonempty string");
	if (panel.icon !== undefined && typeof panel.icon !== "string") throw new Error("Session panel icon must be SVG markup");
	if (typeof panel.mount !== "function") throw new Error("Session panel mount must be a function");
	if (panel.sessions !== undefined && (!Array.isArray(panel.sessions) || !panel.sessions.length || panel.sessions.some(kind => kind !== "teaching" && kind !== "practice"))) throw new Error("Invalid session panel targets");
	for (const key of ["defaultWidth", "minWidth"] as const) {
		const value = panel[key];
		if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) throw new Error(`Session panel ${key} must be a positive number`);
	}
	const minWidth = panel.minWidth ?? PLUGIN_PANEL_MIN_WIDTH;
	const defaultWidth = Math.max(panel.defaultWidth ?? PLUGIN_PANEL_DEFAULT_WIDTH, minWidth);
	return Object.freeze({ id: panel.id, title: panel.title, ...(panel.icon ? { icon: panel.icon } : {}),
		...(panel.sessions ? { sessions: Object.freeze([...panel.sessions]) as ("teaching" | "practice")[] } : {}),
		defaultWidth, minWidth, mount: panel.mount.bind(panel) });
}
