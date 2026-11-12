/** Fork-only frontend extension registrations, kept out of the upstream manager.
 * The manager supplies one activation scope per plugin generation; every entry is
 * bound to that scope plus its own unregister, and aborts its signal on either. */
import type { PluginCleanup } from "@/src/core";

export interface ForkActivationScope {
	readonly pluginId: string;
	readonly pluginName: string;
	readonly signal: AbortSignal;
	isCurrent(): boolean;
	/** Register cleanup on the activation; returns an early remover that runs it. */
	addCleanup(cleanup: PluginCleanup): () => void;
	report(error: unknown): void;
	/** Host transport/navigation for app-level fork methods. */
	fetch?: typeof fetch;
	navigate?(path: string): void;
}
export interface ForkEntry<T> {
	readonly pluginId: string;
	readonly pluginName: string;
	readonly key: string;
	readonly value: T;
	/** Aborted on unregister or activation end. */
	readonly signal: AbortSignal;
	isCurrent(): boolean;
	report(error: unknown): void;
}

export class PluginForkRegistry {
	private kinds = new Map<string, Map<string, ForkEntry<unknown>>>();
	private lists = new Map<string, readonly ForkEntry<unknown>[]>();
	private listeners = new Set<() => void>();
	private version = 0;
	subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
	getVersion = () => this.version;
	changed() {
		this.version++; this.lists.clear();
		for (const listener of [...this.listeners]) listener();
	}
	/** Keys are unique per kind across ALL plugins (pluginId-qualify them when
	 * ownership should be per plugin). Duplicates throw. */
	register<T>(kind: string, scope: ForkActivationScope, key: string, value: T): () => void {
		if (!scope.isCurrent()) return () => {};
		let map = this.kinds.get(kind);
		if (!map) this.kinds.set(kind, map = new Map());
		if (map.has(key)) throw new Error(`Duplicate plugin registration: ${key}`);
		const controller = new AbortController();
		const entry: ForkEntry<T> = Object.freeze({
			pluginId: scope.pluginId, pluginName: scope.pluginName, key, value, signal: controller.signal,
			isCurrent: () => scope.isCurrent() && !controller.signal.aborted && map.get(key) === entry,
			report: (error: unknown) => scope.report(error),
		});
		map.set(key, entry as ForkEntry<unknown>);
		const remove = scope.addCleanup(() => {
			if (map.get(key) === entry) map.delete(key);
			controller.abort();
			this.changed();
		});
		this.changed();
		return remove;
	}
	list<T>(kind: string): readonly ForkEntry<T>[] {
		let list = this.lists.get(kind);
		if (!list) {
			list = Object.freeze([...(this.kinds.get(kind)?.values() ?? [])].filter(entry => entry.isCurrent()));
			this.lists.set(kind, list);
		}
		return list as readonly ForkEntry<T>[];
	}
	get<T>(kind: string, key: string): ForkEntry<T> | undefined {
		const entry = this.kinds.get(kind)?.get(key);
		return entry?.isCurrent() ? entry as ForkEntry<T> : undefined;
	}
}
