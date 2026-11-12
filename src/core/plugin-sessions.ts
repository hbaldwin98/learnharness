/** Seeded native sessions (fork extension E4). Frontend-only in v1. */

export const PLUGIN_SESSION_OPENING_TYPE = "session-opening";
export const PLUGIN_SESSION_NODE_LIMIT = 64;

export interface PluginSessionOpening {
	/** Shown to the learner as the session's first message. */
	displayText: string;
	/** Read by the tutor as `[plugin <id>] <modelText>`. */
	modelText: string;
}
export interface PluginSessionSpec {
	kind: "teaching" | "practice";
	/** Graph node ids seeded as the session's map context (validated against the graph; at most 64). */
	nodeIds?: string[];
	/** Session title; defaults to the opening's displayText or "Untitled session". */
	title?: string;
	/** Stored as a plugin-marker (typeId "session-opening") that also records the plugin origin. */
	opening?: PluginSessionOpening;
	/** Start the first turn server-side right away (requires `opening`), whether or not the session is opened. */
	start?: boolean;
	/** Per plugin, permanent: the same key returns the same (still existing) session. */
	idempotencyKey?: string;
}
export interface PluginSessionsAppContext {
	/** Create a native session seeded by this plugin and resolve its id. With
	 * `open: true` the window navigates to it. Rejects on invalid specs, unknown
	 * nodes or an inactive plugin. */
	createSession(spec: PluginSessionSpec, options?: { open?: boolean }): Promise<string>;
}

/** Validate and return a detached spec. */
export function preparePluginSessionSpec(spec: PluginSessionSpec): PluginSessionSpec {
	if (!spec || typeof spec !== "object") throw new Error("Session spec must be an object");
	if (spec.kind !== "teaching" && spec.kind !== "practice") throw new Error("Session kind must be teaching or practice");
	if (spec.nodeIds !== undefined && (!Array.isArray(spec.nodeIds) || spec.nodeIds.length > PLUGIN_SESSION_NODE_LIMIT || spec.nodeIds.some(id => typeof id !== "string" || !id))) throw new Error(`Session nodeIds must be at most ${PLUGIN_SESSION_NODE_LIMIT} node ids`);
	if (spec.title !== undefined && typeof spec.title !== "string") throw new Error("Session title must be a string");
	if (spec.opening !== undefined && (!spec.opening || typeof spec.opening.displayText !== "string" || !spec.opening.displayText.trim()
		|| typeof spec.opening.modelText !== "string" || !spec.opening.modelText.trim())) throw new Error("Session opening needs nonempty displayText and modelText");
	if (spec.start !== undefined && typeof spec.start !== "boolean") throw new Error("Session start must be boolean");
	if (spec.start && !spec.opening) throw new Error("Starting a session requires an opening");
	if (spec.idempotencyKey !== undefined && (typeof spec.idempotencyKey !== "string" || !spec.idempotencyKey || spec.idempotencyKey.length > 200)) throw new Error("Session idempotencyKey must be a string of 1–200 characters");
	return structuredClone({ kind: spec.kind, ...(spec.nodeIds ? { nodeIds: [...new Set(spec.nodeIds)] } : {}), ...(spec.title !== undefined ? { title: spec.title } : {}),
		...(spec.opening ? { opening: { displayText: spec.opening.displayText, modelText: spec.opening.modelText } } : {}),
		...(spec.start ? { start: true } : {}), ...(spec.idempotencyKey !== undefined ? { idempotencyKey: spec.idempotencyKey } : {}) });
}
