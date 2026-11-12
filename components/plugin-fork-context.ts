/** Fork-only additions to PluginFrontendContext, built per activation generation. */
import {
	preparePluginFieldAccessory, validPluginMarkerTypeId,
	type PluginFieldAccessory, type PluginFieldsFrontendContext, type PluginMarkerRenderer, type PluginMarkersFrontendContext,
} from "../src/core/index.ts";
import type { ForkActivationScope, PluginForkRegistry } from "./plugin-fork-registry.ts";

export const FIELD_ACCESSORIES = "field-accessories";
export const MARKER_RENDERERS = "marker-renderers";

export type PluginForkFrontendContext = PluginFieldsFrontendContext & PluginMarkersFrontendContext;

export function createForkFrontendContext(registry: PluginForkRegistry, scope: ForkActivationScope): PluginForkFrontendContext {
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
	};
}
