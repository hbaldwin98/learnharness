/** Seeded native sessions (fork E4), server side of POST /api/chats with a
 * `plugin` body. Node ids become the ordinary graph-context seed; the opening is
 * a plugin-marker (the only record of plugin origin); idempotency keys are kept
 * permanently per plugin in data/plugin-sessions.json. */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import { newMessageId, type LhMarkerMessage } from "../core/native-messages.ts";
import { PLUGIN_ID_PATTERN } from "../core/plugins.ts";
import { pluginMarkerModelText, type PluginMarkerDetails } from "../core/plugin-markers.ts";
import { PLUGIN_SESSION_OPENING_TYPE, preparePluginSessionSpec, type PluginSessionSpec } from "../core/plugin-sessions.ts";
import type { GraphContextPick } from "../core/native-messages.ts";
import type { ChatStore, GraphStore } from "../core/ports.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";

export interface PluginSessionRequest {
	pluginId: string;
	spec: PluginSessionSpec;
	title: string;
	graphContext?: { propositions: GraphContextPick[] };
	/** An existing session for the same idempotency key. */
	existing?: string;
}
export interface PluginSessionDependencies {
	chatStore: ChatStore;
	graphStore: Pick<GraphStore, "readNodes">;
	isPluginActive(pluginId: string): boolean | Promise<boolean>;
	keysFile?: string;
}

type Keys = Record<string, string>;
const keyOf = (pluginId: string, key: string) => `${pluginId}\u0000${key}`;
function readKeys(file: string): Keys {
	try { const value = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: number; keys?: Keys }; return value.version === 1 && value.keys ? value.keys : {}; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
const defaultKeysFile = () => path.join(/* turbopackIgnore: true */ PATHS.data, "plugin-sessions.json");

export class PluginSessionError extends Error {}

/** Validate the request before any session is created. */
export async function preparePluginSessionRequest(body: { pluginId?: unknown; spec?: unknown }, deps: PluginSessionDependencies): Promise<PluginSessionRequest> {
	const pluginId = body.pluginId;
	if (typeof pluginId !== "string" || !PLUGIN_ID_PATTERN.test(pluginId)) throw new PluginSessionError("Invalid plugin id");
	if (!await deps.isPluginActive(pluginId)) throw new PluginSessionError("Plugin is not active");
	let spec: PluginSessionSpec;
	try { spec = preparePluginSessionSpec(body.spec as PluginSessionSpec); }
	catch (error) { throw new PluginSessionError((error as Error).message); }
	if (spec.idempotencyKey !== undefined) {
		const existing = readKeys(deps.keysFile ?? defaultKeysFile())[keyOf(pluginId, spec.idempotencyKey)];
		if (existing && deps.chatStore.getChat(existing)) return { pluginId, spec, title: "", existing };
	}
	let graphContext: PluginSessionRequest["graphContext"];
	if (spec.nodeIds?.length) {
		const byId = new Map(deps.graphStore.readNodes().map(node => [node.id, node]));
		const missing = spec.nodeIds.filter(id => !byId.has(id));
		if (missing.length) throw new PluginSessionError(`Unknown graph nodes: ${missing.join(", ")}`);
		graphContext = { propositions: spec.nodeIds.map(id => { const node = byId.get(id)!; return { id, name: node.name, statement: node.statement }; }) };
	}
	const title = spec.title?.trim() || spec.opening?.displayText || "Untitled session";
	return { pluginId, spec, title, graphContext };
}

export function pluginOpeningMarker(pluginId: string, spec: PluginSessionSpec): LhMarkerMessage | undefined {
	if (!spec.opening) return undefined;
	const details: PluginMarkerDetails = { pluginId, typeId: PLUGIN_SESSION_OPENING_TYPE, data: null, displayText: spec.opening.displayText, trigger: "learner",
		...(spec.idempotencyKey !== undefined ? { idempotencyKey: spec.idempotencyKey } : {}) };
	return { id: newMessageId(), role: "custom", customType: "plugin-marker", content: pluginMarkerModelText(pluginId, spec.opening.modelText), display: true, details, timestamp: Date.now() };
}

/** After the session exists: remember the key, then append or start the opening.
 * `start` runs the first turn with the opening as its input; a refused start
 * still leaves the opening in the record. */
export async function finishPluginSession(chatId: string, request: PluginSessionRequest, deps: PluginSessionDependencies & {
	startTurn(chatId: string, opening: LhMarkerMessage): Promise<number>;
}): Promise<void> {
	if (request.spec.idempotencyKey !== undefined) {
		const file = deps.keysFile ?? defaultKeysFile();
		const keys = readKeys(file);
		keys[keyOf(request.pluginId, request.spec.idempotencyKey)] = chatId;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		writeFileAtomicSync(file, JSON.stringify({ version: 1, keys }, null, "\t"));
	}
	const opening = pluginOpeningMarker(request.pluginId, request.spec);
	if (!opening) return;
	const append = () => {
		const record = deps.chatStore.getChat(chatId);
		if (!record || record.messages.some(message => message.id === opening.id)) return;
		deps.chatStore.saveMessages(chatId, [...record.messages, opening]);
		emit("record-changed", { chatId });
	};
	if (!request.spec.start) { append(); return; }
	const status = await deps.startTurn(chatId, opening).catch(() => -1);
	if (status !== 200) append();
}
