/** Plugin steers (fork E3): plugin input into a native session's conversation,
 * stored as a plugin-marker and delivered through the jobs wake pipeline
 * (live run → steer, idle → wake, 409 retry, question wait, id dedupe). */
import { createHash } from "node:crypto";
import { endsInDismissal, endsInQuestionRecovery, hasUnresolvedQuestion, type LhMarkerMessage } from "../core/native-messages.ts";
import { steerDelivered } from "../core/contracts/jobs.ts";
import { preparePluginMarker } from "../core/plugin-markers.ts";
import { PLUGIN_STEER_HOURLY_LIMIT, PLUGIN_STEER_MODEL_TEXT_LIMIT, PLUGIN_STEER_RECENT_MS, PLUGIN_STEER_TYPE,
	type PluginSteerInput, type PluginSteerReceipt, type PluginTurnService } from "../core/plugin-turns.ts";
import type { ChatStore } from "../core/ports.ts";

export interface PluginTurnDependencies {
	chatStore: ChatStore;
	signal: AbortSignal;
	deliver(steer: LhMarkerMessage): Promise<void>;
	discard(chatId: string, steerId: string): boolean;
	turnRunning(chatId: string): boolean;
	compacting(chatId: string): boolean;
	now?: () => number;
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

export function createPluginTurnService(pluginId: string, deps: PluginTurnDependencies): PluginTurnService {
	const now = deps.now ?? Date.now;
	/** chatId → undelivered steer id (one in flight per plugin and session). */
	const inFlight = new Map<string, string>();
	/** chatId → wake timestamps within the last hour. */
	const wakes = new Map<string, number[]>();
	deps.signal.addEventListener("abort", () => {
		for (const [chatId, id] of inFlight) deps.discard(chatId, id);
		inFlight.clear();
	}, { once: true });
	return Object.freeze({
		async steer(chatId: string, input: PluginSteerInput): Promise<PluginSteerReceipt> {
			if (deps.signal.aborted) throw new Error("Plugin activation has ended");
			if (typeof chatId !== "string" || !/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error("Invalid session id");
			if (!input || typeof input !== "object") throw new Error("Steer input must be an object");
			if (typeof input.displayText !== "string" || !input.displayText.trim()) throw new Error("Steer displayText must be a nonempty string");
			if (typeof input.modelText !== "string" || !input.modelText.trim()) throw new Error("Steer modelText must be a nonempty string");
			if (bytes(input.modelText) > PLUGIN_STEER_MODEL_TEXT_LIMIT) throw new Error("Steer modelText exceeds 8 KB");
			if (input.trigger !== "learner" && input.trigger !== "background") throw new Error("Steer trigger must be learner or background");
			const mode = input.mode ?? "steer-or-wake";
			if (mode !== "steer-or-wake" && mode !== "steer-only") throw new Error("Unknown steer mode");
			const prepared = preparePluginMarker(pluginId, { typeId: PLUGIN_STEER_TYPE, details: input.details ?? null, modelText: input.modelText, idempotencyKey: input.idempotencyKey });
			const id = "ps_" + createHash("sha256").update(`${pluginId}\u0000${chatId}\u0000${input.idempotencyKey}`).digest("hex").slice(0, 24);
			const record = deps.chatStore.getChat(chatId);
			if (!record) throw new Error("Unknown session");
			// Same key: the same delivery, whether already landed or still queued.
			if (steerDelivered(record.messages as never, id)) return { delivery: deps.turnRunning(chatId) ? "steered" : "woke" };
			if (inFlight.get(chatId) === id) return { delivery: "queued" };
			const touched = Math.max(Date.parse(record.updatedAt) || 0, Date.parse(record.createdAt) || 0);
			if (now() - touched > PLUGIN_STEER_RECENT_MS) throw new Error("Session was not opened or updated in the last 30 minutes");
			if (deps.compacting(chatId)) throw new Error("Session is compacting");
			if (inFlight.has(chatId)) throw new Error("An earlier steer from this plugin to this session is still being delivered");
			const live = deps.turnRunning(chatId);
			if (mode === "steer-only" && !live) throw new Error("No live run to steer");
			const blocked = !live && (hasUnresolvedQuestion(record.messages) || endsInDismissal(record.messages) || endsInQuestionRecovery(record.messages));
			if (!live) {
				const recent = (wakes.get(chatId) ?? []).filter(time => now() - time < 60 * 60_000);
				if (recent.length >= PLUGIN_STEER_HOURLY_LIMIT) throw new Error("Steer wake limit reached for this session (6 per hour)");
				wakes.set(chatId, [...recent, now()]);
			}
			const marker: LhMarkerMessage = { id, role: "custom", customType: "plugin-marker", content: prepared.content, display: true,
				details: { ...prepared.details, displayText: input.displayText, trigger: input.trigger, chatId }, timestamp: now() };
			inFlight.set(chatId, id);
			void deps.deliver(marker).catch(() => undefined).finally(() => { if (inFlight.get(chatId) === id) inFlight.delete(chatId); });
			return { delivery: live ? "steered" : blocked ? "queued" : "woke" };
		},
	});
}
