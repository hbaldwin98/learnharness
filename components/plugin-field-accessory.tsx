"use client";

/** Plugin learner-field accessories (fork E6): host icon buttons inside a learner
 * field. Each click captures a fresh stale-checked handle bound to the field's own
 * draft state; unmount, field replacement, unregister or disable aborts it. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPluginLearnerField, fieldAccessoryApplies, type PluginFieldAccessory, type PluginLearnerField, type PluginLearnerFieldKind } from "@/src/core";
import { usePlugins } from "@/components/plugins";
import { GET_CARET_EVENT, INSERT_TEXT_EVENT, SET_CARET_EVENT } from "@/components/path-input";
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

type Accessory = Readonly<PluginFieldAccessory>;
type AccessoryEntry = ForkEntry<Accessory>;

/** Read the editor's saved caret (source-text offset); null without a live editor. */
export function readFieldCaret(editor: HTMLElement | null | undefined): number | null {
	if (!editor?.isConnected) return null;
	const detail: { offset?: number } = {};
	editor.dispatchEvent(new CustomEvent(GET_CARET_EVENT, { detail }));
	return typeof detail.offset === "number" ? detail.offset : null;
}

/** Move the caret after React applies pending draft writes. */
export function setFieldCaret(editor: HTMLElement | null | undefined, offset: number) {
	setTimeout(() => { if (editor?.isConnected) editor.dispatchEvent(new CustomEvent(SET_CARET_EVENT, { detail: { offset } })); }, 0);
}

/** Fork E6: a learner field's plugin accessories (buttons), previews (slot under
 * the field) and key handling. Call unconditionally; render `accessories` and
 * `preview`, and call `onKeyDown` first in the field's key handler (true = handled). */
export function usePluginLearnerField({ kind, read, write, editorRef }: {
	kind: PluginLearnerFieldKind;
	read: () => string;
	write: (value: string) => void;
	editorRef?: RefObject<HTMLElement | null>;
}): { accessories: ReactNode; preview: ReactNode; onKeyDown(event: ReactKeyboardEvent): boolean } {
	const sessionId = useContext(SessionContext);
	const { manager } = usePlugins();
	const entries = useForkEntries<Accessory>(manager?.fork, FIELD_ACCESSORIES).filter(entry => fieldAccessoryApplies(entry.value, kind));
	const binding = useRef({ read, write }); binding.current = { read, write };
	const listeners = useRef(new Set<(text: string) => void>());
	// One lifetime per mounted field; a different kind/session is a different field.
	const [lifetime, setLifetime] = useState<AbortController | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		setLifetime(controller);
		return () => controller.abort();
	}, [kind, sessionId]);
	// Draft changes from any source re-render the owning field: notify observers.
	const last = useRef<string | null>(null);
	useEffect(() => {
		const value = binding.current.read();
		if (last.current === value) return;
		last.current = value;
		for (const listener of [...listeners.current]) { try { listener(value); } catch { /* isolated */ } }
	});
	const handleFor = useCallback((entry: AccessoryEntry): PluginLearnerField | null => {
		if (!lifetime || lifetime.signal.aborted || !sessionId || !entry.isCurrent()) return null;
		return createPluginLearnerField({
			kind, sessionId,
			read: () => binding.current.read(),
			write: value => binding.current.write(value),
			insert: value => insertIntoField(editorRef?.current, value, binding.current.read, binding.current.write),
			setCaret: offset => setFieldCaret(editorRef?.current, offset),
			caret: () => readFieldCaret(editorRef?.current) ?? binding.current.read().length,
			subscribe: listener => { listeners.current.add(listener); return () => { listeners.current.delete(listener); }; },
		}, AbortSignal.any([lifetime.signal, entry.signal]));
	}, [lifetime, sessionId, kind, editorRef]);
	const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
	const run = (entry: AccessoryEntry, anchor: HTMLElement) => {
		if (busy.has(entry.key)) return;
		const field = handleFor(entry);
		if (!field) return;
		setBusy(previous => new Set(previous).add(entry.key));
		void (async () => {
			try { await entry.value.run(field, Object.freeze({ anchor })); }
			catch (error) { if (entry.isCurrent()) entry.report(error); }
			finally { setBusy(previous => { const next = new Set(previous); next.delete(entry.key); return next; }); }
		})();
	};
	const onKeyDown = (event: ReactKeyboardEvent) => {
		for (const entry of entries) {
			if (!entry.value.onKeyDown) continue;
			const field = handleFor(entry);
			if (!field) continue;
			let handled = false;
			try { handled = entry.value.onKeyDown(event.nativeEvent, field) === true; }
			catch (error) { entry.report(error); }
			if (handled) { event.preventDefault(); event.stopPropagation(); return true; }
		}
		return false;
	};
	const active = !!sessionId && entries.length > 0;
	const accessories = active ? (
		<div data-testid="plugin-field-accessories" className="flex shrink-0 items-center gap-0.5">
			{entries.map(entry => (
				<button
					key={entry.key}
					type="button"
					data-plugin-accessory={entry.key}
					aria-label={entry.value.label}
					title={entry.value.label}
					disabled={busy.has(entry.key)}
					onClick={event => run(entry, event.currentTarget)}
					className="flex size-8 cursor-pointer items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
				>
					<span aria-hidden="true" className="inline-flex size-4 items-center justify-center [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: entry.value.icon }} />
				</button>
			))}
		</div>
	) : null;
	const previews = active ? entries.filter(entry => entry.value.preview) : [];
	const preview = previews.length ? (
		<div data-testid="plugin-field-previews" className="flex min-w-0 flex-col">
			{previews.map(entry => <FieldPreview key={entry.key} entry={entry} handleFor={handleFor} />)}
		</div>
	) : null;
	return { accessories, preview, onKeyDown };
}

function FieldPreview({ entry, handleFor }: { entry: AccessoryEntry; handleFor(entry: AccessoryEntry): PluginLearnerField | null }) {
	const { manager } = usePlugins();
	const container = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string>();
	useEffect(() => {
		const field = handleFor(entry);
		if (!manager || !container.current || !field) return;
		return manager.mount(entry.pluginId, (child, signal) => {
			if (signal.aborted || field.signal.aborted) return;
			return entry.value.preview!.mount(child, field);
		}, container.current, setError);
	}, [manager, entry, handleFor]);
	return <>
		{error && <p role="alert" className="px-2.5 text-xs text-destructive">{entry.value.label}: {error}</p>}
		<div ref={container} data-plugin-preview={entry.key} className="min-w-0" />
	</>;
}
