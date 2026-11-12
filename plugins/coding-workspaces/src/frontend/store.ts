import type { WorkspaceState } from "../shared/protocol.ts";

/** Per-window view state: the latest workspace state per item and which item each chat's editor shows. */
export interface ItemRef {
	chatId: string;
	itemId: string;
	/** Read the editor's live code (absent when no editor is mounted). */
	readCode: () => string;
}

const keyOf = (chatId: string, itemId: string) => `${chatId}\0${itemId}`;

export function createViewStore() {
	const states = new Map<string, WorkspaceState>();
	/** Mounted editors per chat, most recent last. */
	const editors = new Map<string, ItemRef[]>();
	const listeners = new Set<() => void>();
	const notify = () => { for (const listener of [...listeners]) { try { listener(); } catch (error) { console.error(error); } } };
	return {
		setState(state: WorkspaceState) { states.set(keyOf(state.chatId, state.itemId), state); notify(); },
		state: (chatId: string, itemId: string) => states.get(keyOf(chatId, itemId)),
		addEditor(ref: ItemRef): () => void {
			const list = editors.get(ref.chatId) ?? [];
			list.push(ref);
			editors.set(ref.chatId, list);
			notify();
			return () => {
				const current = editors.get(ref.chatId) ?? [];
				const next = current.filter(other => other !== ref);
				if (next.length) editors.set(ref.chatId, next); else editors.delete(ref.chatId);
				notify();
			};
		},
		/** The item whose editor the chat shows (most recently mounted). */
		active: (chatId: string): ItemRef | undefined => editors.get(chatId)?.at(-1),
		/** Every mounted editor's item. */
		all: (): ItemRef[] => [...editors.values()].flat(),
		subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
}

export type ViewStore = ReturnType<typeof createViewStore>;
