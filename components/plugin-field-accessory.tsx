"use client";

/** Plugin learner-field accessories (fork E6): host icon buttons inside a learner
 * field. Each click captures a fresh stale-checked handle bound to the field's own
 * draft state; unmount, field replacement, unregister or disable aborts it. */
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPluginLearnerField, fieldAccessoryApplies, type PluginFieldAccessory, type PluginLearnerFieldKind } from "@/src/core";
import { usePlugins } from "@/components/plugins";
import { INSERT_TEXT_EVENT } from "@/components/path-input";
import { FIELD_ACCESSORIES } from "@/components/plugin-fork-context";
import type { ForkEntry, PluginForkRegistry } from "@/components/plugin-fork-registry";

const SessionContext = createContext<string | null>(null);
/** The owning session page supplies its id once for every learner field below it. */
export function PluginFieldSessionProvider({ sessionId, children }: { sessionId: string; children: ReactNode }) {
	return <SessionContext.Provider value={sessionId}>{children}</SessionContext.Provider>;
}

const noSubscribe = () => () => {};
const noVersion = () => 0;
export function useForkEntries<T>(registry: PluginForkRegistry | undefined, kind: string): readonly ForkEntry<T>[] {
	useSyncExternalStore(registry?.subscribe ?? noSubscribe, registry?.getVersion ?? noVersion, noVersion);
	return registry ? registry.list<T>(kind) : [];
}

/** Insert at the editor's saved caret; append when no live editor accepts it. */
export function insertIntoField(editor: HTMLElement | null | undefined, text: string, read: () => string, write: (value: string) => void) {
	if (editor?.isConnected) {
		const detail: { text: string; inserted?: boolean } = { text };
		editor.dispatchEvent(new CustomEvent(INSERT_TEXT_EVENT, { detail }));
		if (detail.inserted) return;
	}
	write(read() + text);
}

export function PluginFieldAccessories({ kind, read, write, editorRef }: {
	kind: PluginLearnerFieldKind;
	read: () => string;
	write: (value: string) => void;
	editorRef?: RefObject<HTMLElement | null>;
}) {
	const sessionId = useContext(SessionContext);
	const { manager } = usePlugins();
	const entries = useForkEntries<Readonly<PluginFieldAccessory>>(manager?.fork, FIELD_ACCESSORIES)
		.filter(entry => fieldAccessoryApplies(entry.value, kind));
	const binding = useRef({ read, write }); binding.current = { read, write };
	// One lifetime per mounted field; a different kind is a different field.
	const [lifetime, setLifetime] = useState<AbortController | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		setLifetime(controller);
		return () => controller.abort();
	}, [kind, sessionId]);
	const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
	if (!sessionId || !entries.length) return null;
	const run = (entry: ForkEntry<Readonly<PluginFieldAccessory>>) => {
		if (!lifetime || lifetime.signal.aborted || busy.has(entry.key) || !entry.isCurrent()) return;
		const signal = AbortSignal.any([lifetime.signal, entry.signal]);
		const field = createPluginLearnerField({
			kind, sessionId,
			read: () => binding.current.read(),
			write: value => binding.current.write(value),
			insert: value => insertIntoField(editorRef?.current, value, binding.current.read, binding.current.write),
		}, signal);
		setBusy(previous => new Set(previous).add(entry.key));
		void (async () => {
			try { await entry.value.run(field); }
			catch (error) { if (entry.isCurrent()) entry.report(error); }
			finally { setBusy(previous => { const next = new Set(previous); next.delete(entry.key); return next; }); }
		})();
	};
	return (
		<div data-testid="plugin-field-accessories" className="flex shrink-0 items-center gap-0.5">
			{entries.map(entry => (
				<button
					key={entry.key}
					type="button"
					data-plugin-accessory={entry.key}
					aria-label={entry.value.label}
					title={entry.value.label}
					disabled={busy.has(entry.key)}
					onClick={() => run(entry)}
					className="flex size-8 cursor-pointer items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
				>
					<span aria-hidden="true" className="inline-flex size-4 items-center justify-center [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: entry.value.icon }} />
				</button>
			))}
		</div>
	);
}
