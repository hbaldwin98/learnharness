/** Backend steer / start-turn into a native session (fork extension E3; a fork
 * exception to the session-extension contract §1, not proposed upstream). */

export const PLUGIN_STEER_TYPE = "steer";
export const PLUGIN_STEER_MODEL_TEXT_LIMIT = 8 * 1024;
export const PLUGIN_STEER_RECENT_MS = 30 * 60_000;
export const PLUGIN_STEER_HOURLY_LIMIT = 6;

export interface PluginSteerInput {
	/** Shown to the learner in the transcript (unless a marker renderer for typeId "steer" presents it). */
	displayText: string;
	/** Read by the tutor as `[plugin <id>] <modelText>`; at most 8 KB (UTF-8). */
	modelText: string;
	/** JSON-compatible renderer payload (marker `data`), at most 64 KB. */
	details?: unknown;
	/** Per plugin and session: a repeated key is the same delivery, never a second one. */
	idempotencyKey: string;
	/** `learner`: caused by a learner action (interactive purpose). `background`: automatic (background purpose, subject to connection consent). */
	trigger: "learner" | "background";
	/** `steer-or-wake` (default): steer a live run, else wake an idle session.
	 * `steer-only`: reject unless a run is live. */
	mode?: "steer-or-wake" | "steer-only";
}
export interface PluginSteerReceipt {
	/** `steered`: handed to the live run. `woke`: an idle session starts a turn.
	 * `queued`: held until the session can take a turn (a pending question or a
	 * learner dismissal pause); delivered later by the host. */
	delivery: "steered" | "woke" | "queued";
}
export interface PluginTurnService {
	/** Deliver plugin input into a native session's conversation, stored as a
	 * plugin-marker. Rejects for unknown sessions, sessions not opened/updated in
	 * the last 30 minutes, a running compaction, an undelivered earlier steer from
	 * this plugin to the session, more than 6 wakes per hour per session, invalid
	 * input or an expired activation. Queued steers are dropped on disable. */
	steer(chatId: string, input: PluginSteerInput): Promise<PluginSteerReceipt>;
}
export interface PluginTurnsBackendContext {
	readonly turns: PluginTurnService;
}
