/** Fork-only additions to PluginFrontendContext, built per activation generation. */
import {
	preparePluginFieldAccessory, preparePluginSessionPanel, validPluginMarkerTypeId,
	type PluginFieldAccessory, type PluginFieldsFrontendContext, type PluginMarkerRenderer, type PluginMarkersFrontendContext,
	type PluginPanelsAppContext, type PluginPanelsFrontendContext, type PluginSessionPanel,
	preparePluginSessionSpec, type PluginSessionsAppContext, type PluginSessionSpec,
} from "../src/core/index.ts";
import type { ForkActivationScope, PluginForkRegistry } from "./plugin-fork-registry.ts";
import { pluginPanelStore, type PluginPanelStore } from "./plugin-panel-store.ts";

export const FIELD_ACCESSORIES = "field-accessories";
export const MARKER_RENDERERS = "marker-renderers";
export const SESSION_PANELS = "session-panels";

export type PluginForkFrontendContext = PluginFieldsFrontendContext & PluginMarkersFrontendContext & PluginPanelsFrontendContext & { app: PluginPanelsAppContext & PluginSessionsAppContext };

export function createForkFrontendContext(registry: PluginForkRegistry, scope: ForkActivationScope, panels: PluginPanelStore = pluginPanelStore): PluginForkFrontendContext {
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
		},
	};
}
