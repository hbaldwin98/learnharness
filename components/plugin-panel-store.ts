/** Per-window open/width state for plugin session panels (fork E2), persisted in
 * localStorage per session (open panel) and per session+panel (width). Storage
 * failures degrade to in-memory state. */

const OPEN_PREFIX = "lh:plugin-panel:open:";
const WIDTH_PREFIX = "lh:plugin-panel:width:";

function storage(): Storage | undefined {
	try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

export class PluginPanelStore {
	private open = new Map<string, string | null>();
	private widths = new Map<string, number>();
	private listeners = new Set<() => void>();
	private version = 0;
	constructor(private store: () => Storage | undefined = storage) {}
	subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
	getVersion = () => this.version;
	private changed() { this.version++; for (const listener of [...this.listeners]) listener(); }
	/** "pluginId/panelId" of the session's open panel, or null. */
	openPanel(sessionId: string): string | null {
		if (!this.open.has(sessionId)) {
			let value: string | null = null;
			try { value = this.store()?.getItem(OPEN_PREFIX + sessionId) ?? null; } catch { /* in-memory only */ }
			this.open.set(sessionId, value);
		}
		return this.open.get(sessionId) ?? null;
	}
	setOpen(sessionId: string, key: string | null) {
		if (this.openPanel(sessionId) === key) return;
		this.open.set(sessionId, key);
		try {
			if (key) this.store()?.setItem(OPEN_PREFIX + sessionId, key);
			else this.store()?.removeItem(OPEN_PREFIX + sessionId);
		} catch { /* in-memory only */ }
		this.changed();
	}
	width(sessionId: string, key: string, fallback: number): number {
		const id = `${sessionId}:${key}`;
		if (!this.widths.has(id)) {
			let value = NaN;
			try { value = Number(this.store()?.getItem(WIDTH_PREFIX + id)); } catch { /* in-memory only */ }
			if (Number.isFinite(value) && value > 0) this.widths.set(id, value);
		}
		return this.widths.get(id) ?? fallback;
	}
	setWidth(sessionId: string, key: string, width: number) {
		const id = `${sessionId}:${key}`;
		this.widths.set(id, width);
		try { this.store()?.setItem(WIDTH_PREFIX + id, String(Math.round(width))); } catch { /* in-memory only */ }
		this.changed();
	}
}

/** One store per window, shared by the host and plugin app methods. */
export const pluginPanelStore = new PluginPanelStore();
