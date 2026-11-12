/** Plugin transcript markers (fork E1), server side. Idle sessions get a direct
 * write-ahead append; while a turn owns the chat the marker is parked and applied
 * from the turn's settle path (after persistTurn, before endTurn), the same
 * ordering law as parked dismissals. Parks live on globalThis like the other
 * per-chat registries so every Next module instance sees one queue. */
import { emit } from "../core/events.ts";
import { newMessageId, type LhMarkerMessage } from "../core/native-messages.ts";
import { preparePluginMarker, readPluginMarkerDetails, type PluginMarkerInput, type PluginMarkerReceipt, type PluginMarkerService } from "../core/plugin-markers.ts";
import type { ChatStore } from "../core/ports.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { compactionInFlight } from "./compaction.ts";

interface LhGlobal { __lhParkedPluginMarkers?: Map<string, LhMarkerMessage[]> }
function parked(): Map<string, LhMarkerMessage[]> {
	const g = globalThis as typeof globalThis & LhGlobal;
	return (g.__lhParkedPluginMarkers ??= new Map());
}
const COMPACTION_POLL_MS = 250;

function existing(messages: readonly { id?: string; role?: string }[], pluginId: string, key: string): LhMarkerMessage | undefined {
	for (const message of messages) {
		if (message.role !== "custom" || (message as LhMarkerMessage).customType !== "plugin-marker") continue;
		const details = readPluginMarkerDetails((message as LhMarkerMessage).details);
		if (details?.pluginId === pluginId && details.idempotencyKey === key) return message as LhMarkerMessage;
	}
}

export interface PluginMarkerDependencies {
	chatStore: ChatStore;
	signal: AbortSignal;
	turnRunning?: (chatId: string) => boolean;
	compacting?: (chatId: string) => boolean;
	delay?: (ms: number) => Promise<void>;
}

export async function appendPluginMarker(pluginId: string, chatId: string, input: PluginMarkerInput, deps: PluginMarkerDependencies): Promise<PluginMarkerReceipt> {
	const turnRunning = deps.turnRunning ?? isTurnRunning, compacting = deps.compacting ?? compactionInFlight;
	const wait = deps.delay ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const live = () => { if (deps.signal.aborted) throw new Error("Plugin activation has ended"); };
	live();
	if (typeof chatId !== "string" || !/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error("Invalid session id");
	const { details, content } = preparePluginMarker(pluginId, input);
	// Compaction rewrites the record from a snapshot; never append under it.
	while (compacting(chatId)) { await wait(COMPACTION_POLL_MS); live(); }
	// No await below: check, idempotency and write are one synchronous step.
	const record = deps.chatStore.getChat(chatId);
	if (!record) throw new Error("Unknown session");
	if (details.idempotencyKey !== undefined) {
		const found = existing([...record.messages, ...(parked().get(chatId) ?? [])], pluginId, details.idempotencyKey);
		if (found) return { messageId: found.id, chatId };
	}
	const marker: LhMarkerMessage = { id: newMessageId(), role: "custom", customType: "plugin-marker", content, display: true, details, timestamp: Date.now() };
	if (turnRunning(chatId)) {
		const queue = parked().get(chatId) ?? [];
		queue.push(marker);
		parked().set(chatId, queue);
	} else {
		deps.chatStore.saveMessages(chatId, [...record.messages, marker]);
		emit("record-changed", { chatId });
	}
	return { messageId: marker.id, chatId };
}

/** Settle-path hook: land parked markers after the turn's own messages. */
export function applyParkedPluginMarkers(chatStore: ChatStore, chatId: string): void {
	const queue = parked().get(chatId);
	if (!queue?.length) return;
	parked().delete(chatId);
	const record = chatStore.getChat(chatId);
	if (!record) return;
	const present = new Set(record.messages.map(message => message.id));
	const appends = queue.filter(marker => !present.has(marker.id));
	if (!appends.length) return;
	chatStore.saveMessages(chatId, [...record.messages, ...appends]);
	emit("record-changed", { chatId });
}

export function createPluginMarkerService(pluginId: string, deps: PluginMarkerDependencies): PluginMarkerService {
	return Object.freeze({ append: (chatId: string, marker: PluginMarkerInput) => appendPluginMarker(pluginId, chatId, marker, deps) });
}
