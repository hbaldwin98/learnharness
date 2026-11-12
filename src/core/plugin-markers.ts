/** Plugin transcript markers (fork extension E1): plugin-owned entries in a native
 * session transcript. One generic "plugin-marker" custom message carries
 * `details: { pluginId, typeId, data }`; the frontend renderer registered for
 * (pluginId, typeId) presents it. Browser-safe contracts and host helpers. */

/** Serialized UTF-8 JSON byte cap for `details`. */
export const PLUGIN_MARKER_DETAILS_LIMIT = 64 * 1024;

export interface PluginMarkerInput {
	/** Plugin-scoped renderer key: lowercase-hyphen. */
	typeId: string;
	/** JSON-compatible renderer payload, at most 64 KB serialized. Never model-visible. */
	details: unknown;
	/** Model-facing text. Omitted: the marker is invisible to the model. Present:
	 * the model reads it as `[plugin <id>] <modelText>` from its next request on. */
	modelText?: string;
	/** Per plugin and session: a repeated key returns the first marker instead of
	 * appending another one. */
	idempotencyKey?: string;
}
export interface PluginMarkerReceipt {
	messageId: string;
	chatId: string;
}
export interface PluginMarkerService {
	/** Append a marker to a native session. Idle sessions are written at once;
	 * while a turn runs the marker is held and lands right after that turn's
	 * messages are persisted (before turn-settled). Rejects for unknown sessions,
	 * invalid input or an expired activation. Does not start a turn. */
	append(chatId: string, marker: PluginMarkerInput): Promise<PluginMarkerReceipt>;
}
export interface PluginMarkersBackendContext {
	/** Transcript markers owned by this plugin. */
	readonly markers: PluginMarkerService;
}
export interface PluginMarkerRenderProps {
	/** The `details` passed to append (detached copy). */
	readonly details: unknown;
	readonly messageId: string;
	readonly sessionId: string;
	/** Aborted on unmount, replacement, unregister or disable. */
	readonly signal: AbortSignal;
}
export interface PluginMarkerRenderer {
	/** Matches markers this plugin appended with the same typeId. */
	typeId: string;
	/** Render into the container; return sync/async cleanup. Without a live
	 * renderer (plugin disabled/missing) the host shows a muted fallback. */
	mount(container: HTMLElement, marker: PluginMarkerRenderProps): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}
export interface PluginMarkersFrontendContext {
	/** Present this plugin's markers of one typeId. Invalid/duplicate typeIds
	 * throw. Returns unregister, which aborts existing mounts. */
	registerMarkerRenderer(renderer: PluginMarkerRenderer): () => void;
}

/** The record payload of a "plugin-marker" custom message. */
export interface PluginMarkerDetails {
	pluginId: string;
	typeId: string;
	data: unknown;
	idempotencyKey?: string;
	/** Host-owned learner-visible text (E3 steers, E4 openings); shown when no
	 * renderer is registered for the typeId. */
	displayText?: string;
	/** Host-owned request cause for markers that start turns (E3/E4). */
	trigger?: "learner" | "background";
	/** Host-owned: the session this steer targets (E3 delivery routing). */
	chatId?: string;
}

const TYPE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const bytes = (text: string) => new TextEncoder().encode(text).length;

export function validPluginMarkerTypeId(typeId: unknown): typeId is string {
	return typeof typeId === "string" && typeId.length <= 64 && TYPE_ID.test(typeId);
}
/** Validate input and return the detached record details plus model content. */
export function preparePluginMarker(pluginId: string, input: PluginMarkerInput): { details: PluginMarkerDetails; content: string } {
	if (!input || typeof input !== "object") throw new Error("Plugin marker must be an object");
	if (!validPluginMarkerTypeId(input.typeId)) throw new Error("Plugin marker typeId must be a lowercase-hyphen id of at most 64 characters");
	let serialized: string | undefined;
	try { serialized = JSON.stringify(input.details); } catch { /* reported below */ }
	if (serialized === undefined) throw new Error("Plugin marker details must be JSON-compatible");
	if (bytes(serialized) > PLUGIN_MARKER_DETAILS_LIMIT) throw new Error("Plugin marker details exceed 64 KB");
	if (input.modelText !== undefined && (typeof input.modelText !== "string" || !input.modelText.trim())) throw new Error("Plugin marker modelText must be a nonempty string when present");
	if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== "string" || !input.idempotencyKey || input.idempotencyKey.length > 200)) throw new Error("Plugin marker idempotencyKey must be a string of 1–200 characters");
	return {
		details: { pluginId, typeId: input.typeId, data: JSON.parse(serialized), ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}) },
		content: input.modelText === undefined ? "" : pluginMarkerModelText(pluginId, input.modelText),
	};
}
/** The host-prefixed model framing. */
export function pluginMarkerModelText(pluginId: string, modelText: string): string {
	return `[plugin ${pluginId}] ${modelText}`;
}
export function readPluginMarkerDetails(details: unknown): PluginMarkerDetails | null {
	if (!details || typeof details !== "object") return null;
	const value = details as Partial<PluginMarkerDetails>;
	return typeof value.pluginId === "string" && typeof value.typeId === "string" ? value as PluginMarkerDetails : null;
}

/** Fork E3/E4: a wake whose every input is a learner-triggered plugin marker runs
 * with interactive (foreground) purpose instead of background. */
export function learnerTriggeredSteers(input: { type: string; steers?: readonly unknown[] }): boolean {
	return input.type === "steers" && !!input.steers?.length && input.steers.every(steer => {
		const message = steer as { role?: string; customType?: string; details?: { trigger?: unknown } | null };
		return message.role === "custom" && message.customType === "plugin-marker" && message.details?.trigger === "learner";
	});
}
