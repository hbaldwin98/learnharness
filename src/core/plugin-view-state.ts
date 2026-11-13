/** View state in the URL (fork extension E11). Frontend-only. */

/** A view's URL state: flat string query parameters. */
export type PluginViewState = Record<string, string>;
export interface PluginViewStateAppContext {
	/** Query state of the URL while one of this plugin's views is open, so refresh,
	 * Back/Forward and shared links restore the view's place. Every method is a no-op
	 * (or returns `{}`) when the window shows something else or after activation expiry. */
	readonly viewState: {
		/** Read the current URL's query parameters as a fresh object. */
		get(): PluginViewState;
		/** Replace the open view's query state. Pushes a history entry unless
		 * `replace: true`. Does not remount the view or notify `onChange`. */
		set(state: PluginViewState, options?: { replace?: boolean }): void;
		/** Navigate to this plugin's registered view ID with initial query state. */
		open(viewId: string, state?: PluginViewState): void;
		/** Observe state changes made by Back/Forward within the open view. Returns
		 * unsubscribe; expires with the activation. */
		onChange(listener: (state: PluginViewState) => void): () => void;
	};
}

/** Validate and return a detached state. */
export function preparePluginViewState(state: unknown): PluginViewState {
	if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("View state must be an object of strings");
	const result: PluginViewState = {};
	for (const [key, value] of Object.entries(state)) {
		if (!key || typeof value !== "string") throw new Error("View state keys must be nonempty and values strings");
		result[key] = value;
	}
	return result;
}
/** `?a=1&b=2` for a state, or "" when empty. */
export function pluginViewStateQuery(state: PluginViewState): string {
	const query = new URLSearchParams(state).toString();
	return query ? `?${query}` : "";
}
