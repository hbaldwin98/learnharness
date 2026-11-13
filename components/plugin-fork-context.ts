/** Fork-only additions to PluginFrontendContext, built per activation generation. */
import {
	preparePluginFieldAccessory, preparePluginSessionPanel, validPluginMarkerTypeId,
	type PluginFieldAccessory, type PluginFieldsFrontendContext, type PluginMarkerRenderer, type PluginMarkersFrontendContext,
	type PluginPanelsAppContext, type PluginPanelsFrontendContext, type PluginSessionPanel,
	preparePluginSessionSpec, type PluginSessionsAppContext, type PluginSessionSpec,
	preparePluginViewState, pluginViewStateQuery, type PluginViewState, type PluginViewStateAppContext,
} from "../src/core/index.ts";
import type { ForkActivationScope, PluginForkRegistry } from "./plugin-fork-registry.ts";
import { pluginPanelStore, type PluginPanelStore } from "./plugin-panel-store.ts";

export const FIELD_ACCESSORIES = "field-accessories";
export const MARKER_RENDERERS = "marker-renderers";
export const SESSION_PANELS = "session-panels";

export type PluginForkFrontendContext = PluginFieldsFrontendContext & PluginMarkersFrontendContext & PluginPanelsFrontendContext & { app: PluginPanelsAppContext & PluginSessionsAppContext & PluginViewStateAppContext };

/** The window URL/history seen by E11 view state (injectable for tests). */
export interface ForkViewHistory {
	pathname(): string;
	search(): string;
	/** Same-document URL change; Next.js syncs native pushState/replaceState. */
	write(url: string, replace: boolean): void;
	onPop(listener: () => void): () => void;
}
const browserViewHistory: ForkViewHistory = {
	pathname: () => typeof window === "undefined" ? "" : window.location.pathname,
	search: () => typeof window === "undefined" ? "" : window.location.search,
	write: (url, replace) => { if (typeof window !== "undefined") window.history[replace ? "replaceState" : "pushState"](null, "", url); },
	onPop: listener => {
		if (typeof window === "undefined") return () => {};
		window.addEventListener("popstate", listener);
		return () => window.removeEventListener("popstate", listener);
	},
};

export function createForkFrontendContext(registry: PluginForkRegistry, scope: ForkActivationScope, panels: PluginPanelStore = pluginPanelStore, history: ForkViewHistory = browserViewHistory): PluginForkFrontendContext {
	const viewPrefix = `/plugins/${encodeURIComponent(scope.pluginId)}/`;
	const onOwnView = () => { const path = history.pathname(); return path.startsWith(viewPrefix) && path.length > viewPrefix.length; };
	const currentViewState = (): PluginViewState => onOwnView() ? Object.fromEntries(new URLSearchParams(history.search())) : {};
	const sessionId = (value: unknown): string => { if (typeof value !== "string" || !value) throw new Error("Invalid session id"); return value; };
	return {
		registerFieldAccessory: (accessory: PluginFieldAccessory) => {
			if (!scope.isCurrent()) return () => {};
			const owned = preparePluginFieldAccessory(accessory);
			return registry.register(FIELD_ACCESSORIES, scope, `${scope.pluginId}/${owned.id}`, owned);
		},
		registerMarkerRenderer: (renderer: PluginMarkerRenderer) => {
			if (!scope.isCurrent()) return () => {};
			if (!renderer || !validPluginMarkerTypeId(renderer.typeId)) throw new Error("Marker renderer typeId must be a lowercase-hyphen id of at most 64 characters");
			if (typeof renderer.mount !== "function") throw new Error("Marker renderer mount must be a function");
			const owned: Readonly<PluginMarkerRenderer> = Object.freeze({ typeId: renderer.typeId, mount: renderer.mount.bind(renderer) });
			return registry.register(MARKER_RENDERERS, scope, `${scope.pluginId}/${owned.typeId}`, owned);
		},
		registerSessionPanel: (panel: PluginSessionPanel) => {
			if (!scope.isCurrent()) return () => {};
			const owned = preparePluginSessionPanel(panel);
			return registry.register(SESSION_PANELS, scope, `${scope.pluginId}/${owned.id}`, owned);
		},
		app: {
			openSessionPanel: (session, panelId) => {
				if (!scope.isCurrent()) return;
				if (typeof panelId !== "string" || !panelId) throw new Error("Invalid session panel id");
				panels.setOpen(sessionId(session), `${scope.pluginId}/${panelId}`);
			},
			closeSessionPanel: session => { if (scope.isCurrent()) panels.setOpen(sessionId(session), null); },
			createSession: async (spec: PluginSessionSpec, options?: { open?: boolean }) => {
				const live = () => { if (!scope.isCurrent()) throw new Error("Plugin is no longer active"); };
				live();
				if (!scope.fetch) throw new Error("Session creation is unavailable");
				const prepared = preparePluginSessionSpec(spec);
				const response = await scope.fetch("/api/chats", { method: "POST", headers: { "content-type": "application/json" },
					body: JSON.stringify({ plugin: { pluginId: scope.pluginId, spec: prepared } }), signal: scope.signal });
				const body = await response.json().catch(() => ({})) as { id?: unknown; error?: unknown };
				if (!response.ok || typeof body.id !== "string") throw new Error(typeof body.error === "string" ? body.error : `Session creation failed (${response.status})`);
				live();
				if (options?.open) scope.navigate?.(`/chat/${encodeURIComponent(body.id)}`);
				return body.id;
			},
			viewState: {
				get: currentViewState,
				set: (state, options) => {
					const query = pluginViewStateQuery(preparePluginViewState(state));
					if (scope.isCurrent() && onOwnView()) history.write(history.pathname() + query, options?.replace === true);
				},
				open: (viewId, state = {}) => {
					if (typeof viewId !== "string" || !viewId) throw new Error("Invalid view id");
					const query = pluginViewStateQuery(preparePluginViewState(state));
					if (scope.isCurrent()) scope.navigate?.(viewPrefix + encodeURIComponent(viewId) + query);
				},
				onChange: listener => {
					if (!scope.isCurrent()) return () => {};
					if (typeof listener !== "function") throw new Error("View state listener must be a function");
					const stop = history.onPop(() => {
						if (!scope.isCurrent() || !onOwnView()) return;
						try { listener(currentViewState()); } catch (error) { scope.report(error); }
					});
					return scope.addCleanup(stop);
				},
			},
		},
	};
}
