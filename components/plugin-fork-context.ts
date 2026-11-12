/** Fork-only additions to PluginFrontendContext, built per activation generation. */
import { preparePluginFieldAccessory, type PluginFieldAccessory, type PluginFieldsFrontendContext } from "../src/core/index.ts";
import type { ForkActivationScope, PluginForkRegistry } from "./plugin-fork-registry.ts";

export const FIELD_ACCESSORIES = "field-accessories";

export type PluginForkFrontendContext = PluginFieldsFrontendContext;

export function createForkFrontendContext(registry: PluginForkRegistry, scope: ForkActivationScope): PluginForkFrontendContext {
	return {
		registerFieldAccessory: (accessory: PluginFieldAccessory) => {
			if (!scope.isCurrent()) return () => {};
			const owned = preparePluginFieldAccessory(accessory);
			return registry.register(FIELD_ACCESSORIES, scope, `${scope.pluginId}/${owned.id}`, owned);
		},
	};
}
