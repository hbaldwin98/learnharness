/** Learner-field accessories (fork extension E6). Browser-safe contracts plus the
 * host's pure validation/handle helpers; plugins use the supplied context only. */

export const PLUGIN_LEARNER_FIELD_KINDS = ["composer", "question-answer", "practice-answer", "thinking"] as const;
/** `composer`: the session chat composer. `question-answer`: a text-mode native
 * question's answer. `practice-answer`: the native practice dock's field.
 * `thinking`: a select-mode native question's thinking field. */
export type PluginLearnerFieldKind = typeof PLUGIN_LEARNER_FIELD_KINDS[number];

/** A live handle to one mounted learner field, captured when the accessory runs.
 * Writes go through the field's own draft state (as if the learner typed), never
 * a hidden copy. Once `signal` aborts (field unmounted/replaced, accessory
 * unregistered or plugin disabled) every method throws; capture a fresh handle
 * by running the accessory again. */
export interface PluginLearnerField {
	readonly kind: PluginLearnerFieldKind;
	readonly sessionId: string;
	/** Current draft text of the field. */
	read(): string;
	/** Replace the whole draft text. */
	write(text: string): void;
	/** Insert at the field's last caret/selection (replacing a selection), or
	 * append when the field has no live editor. */
	insert(text: string): void;
	readonly signal: AbortSignal;
}
export interface PluginFieldAccessory {
	/** Route-safe id, unique within this plugin. */
	id: string;
	/** Accessible name and tooltip. */
	label: string;
	/** Trusted plugin SVG markup rendered inside a host icon button. */
	icon: string;
	/** Field kinds that show this accessory; omitted means every kind. */
	fields?: PluginLearnerFieldKind[];
	/** Invoked on click. The host prevents repeat invocation while a run is pending
	 * and reports thrown/rejected errors. */
	run(field: PluginLearnerField): void | Promise<void>;
}
export interface PluginFieldsFrontendContext {
	/** Add an icon button to learner input fields. Invalid or duplicate ids throw.
	 * Returns unregister, which aborts handles captured by pending runs. */
	registerFieldAccessory(accessory: PluginFieldAccessory): () => void;
}

/** Host validation: returns a frozen receiver-bound copy. */
export function preparePluginFieldAccessory(accessory: PluginFieldAccessory): Readonly<PluginFieldAccessory> {
	if (!accessory || typeof accessory !== "object") throw new Error("Field accessory must be an object");
	if (typeof accessory.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(accessory.id)) throw new Error("Field accessory id must be a route-safe string of 1–128 characters");
	if (typeof accessory.label !== "string" || !accessory.label.trim()) throw new Error("Field accessory label must be a nonempty string");
	if (typeof accessory.icon !== "string" || !accessory.icon.trim()) throw new Error("Field accessory icon must be SVG markup");
	if (typeof accessory.run !== "function") throw new Error("Field accessory run must be a function");
	if (accessory.fields !== undefined && (!Array.isArray(accessory.fields) || !accessory.fields.length
		|| accessory.fields.some(kind => !PLUGIN_LEARNER_FIELD_KINDS.includes(kind)) || new Set(accessory.fields).size !== accessory.fields.length)) {
		throw new Error("Field accessory fields must be a nonempty list of known field kinds");
	}
	return Object.freeze({ id: accessory.id, label: accessory.label, icon: accessory.icon,
		...(accessory.fields ? { fields: Object.freeze([...accessory.fields]) as PluginLearnerFieldKind[] } : {}),
		run: accessory.run.bind(accessory) });
}

export function fieldAccessoryApplies(accessory: Pick<PluginFieldAccessory, "fields">, kind: PluginLearnerFieldKind): boolean {
	return !accessory.fields || accessory.fields.includes(kind);
}

/** Host-side binding of a field to its draft state. */
export interface PluginLearnerFieldBinding {
	kind: PluginLearnerFieldKind;
	sessionId: string;
	read(): string;
	write(text: string): void;
	insert(text: string): void;
}
/** Create a stale-checked handle; every call rechecks `signal` before touching the field. */
export function createPluginLearnerField(binding: PluginLearnerFieldBinding, signal: AbortSignal): PluginLearnerField {
	const live = () => { if (signal.aborted) throw new Error("This learner field handle is stale"); };
	const text = (value: unknown): string => { if (typeof value !== "string") throw new TypeError("Learner field text must be a string"); return value; };
	return Object.freeze({
		kind: binding.kind, sessionId: binding.sessionId, signal,
		read: () => { live(); return binding.read(); },
		write: (value: string) => { live(); binding.write(text(value)); },
		insert: (value: string) => { live(); binding.insert(text(value)); },
	});
}
