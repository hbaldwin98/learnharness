/** Fork E4 glue for POST /api/chats: validation, idempotent reuse and the
 * post-create opening/start, wired to the real stores, plugin host and turns. */
import { stores } from "./stores.ts";
import { getPluginHost } from "./plugins.ts";
import { handleChatInput } from "./chat-handler.ts";
import { finishPluginSession, PluginSessionError, preparePluginSessionRequest, type PluginSessionRequest } from "./plugin-sessions.ts";

export async function pluginSessionCreation(body: unknown): Promise<Response | { request: PluginSessionRequest; finish(chatId: string): Promise<void> }> {
	const deps = {
		chatStore: stores.chatStore, graphStore: stores.graphStore,
		isPluginActive: async (id: string) => (await getPluginHost()).list().some(info => info.id === id && info.enabled && info.status === "active"),
	};
	let request: PluginSessionRequest;
	try { request = await preparePluginSessionRequest((body ?? {}) as { pluginId?: unknown; spec?: unknown }, deps); }
	catch (error) {
		if (error instanceof PluginSessionError) return Response.json({ error: error.message }, { status: 400 });
		throw error;
	}
	if (request.existing) {
		const chat = stores.chatStore.getChat(request.existing)!;
		return Response.json({ id: chat.id, title: chat.title });
	}
	return { request, finish: chatId => finishPluginSession(chatId, request, { ...deps, startTurn: async (id, opening) => {
		const response = await handleChatInput(id, { type: "steers", steers: [opening] });
		// The turn runs server-side; drain its stream so settlement happens.
		void response.arrayBuffer().catch(() => undefined);
		return response.status;
	} }) };
}
