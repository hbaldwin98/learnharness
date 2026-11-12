/** Plugin themes (fork E9): theme JSON files listed in an enabled plugin's
 * manifest, validated with the host theme validator and offered read-only next
 * to presets and imported themes. Ids are `<pluginId>-<file stem slug>`. A
 * disabled plugin's themes disappear; a selected one then renders as Default. */
import { parseThemeFile, themeIdFromName, isThemeId, type Theme } from "../core/themes.ts";

export interface PluginThemeSource { themeFiles(): { pluginId: string; file: string; text: string }[] }

export function pluginThemeId(pluginId: string, file: string): string {
	return `${pluginId}-${themeIdFromName(file.replace(/\.json$/i, ""))}`.slice(0, 64).replace(/-+$/g, "");
}

export function listPluginThemes(source: PluginThemeSource | undefined): Theme[] {
	if (!source) return [];
	const out: Theme[] = [];
	for (const { pluginId, file, text } of source.themeFiles()) {
		let raw: unknown;
		try { raw = JSON.parse(text); } catch { continue; }
		const parsed = parseThemeFile(raw);
		const id = pluginThemeId(pluginId, file);
		if (!parsed.ok || !isThemeId(id) || out.some(theme => theme.id === id)) continue;
		out.push({ ...parsed.theme, id, builtin: false, plugin: pluginId });
	}
	return out;
}

export function readPluginTheme(source: PluginThemeSource | undefined, id: string): Theme | null {
	return listPluginThemes(source).find(theme => theme.id === id) ?? null;
}
