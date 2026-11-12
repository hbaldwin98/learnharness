import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginManifest } from "../src/core/plugins.ts";
import { BUILTIN_THEMES, resolveTheme } from "../src/core/themes.ts";
import { listPluginThemes, pluginThemeId, readPluginTheme } from "../src/server/plugin-themes.ts";

const manifest = (themes: unknown) => ({ apiVersion: 1, id: "graphite", name: "Graphite", version: "1.0.0", minAppVersion: "0.1.0", main: "main.js", themes });

test("manifest themes must be distinct root .json files", () => {
	assert.deepEqual(parsePluginManifest(manifest(["dark.json"]), "graphite", "0.6.1").themes, ["dark.json"]);
	assert.equal(parsePluginManifest(manifest(undefined), "graphite", "0.6.1").themes, undefined);
	for (const bad of [["a/b.json"], ["x.css"], ["a.json", "a.json"], "a.json"]) assert.throws(() => parsePluginManifest(manifest(bad), "graphite", "0.6.1"), /themes/);
});

test("plugin themes validate with the host validator, get plugin ids and resolve like imported themes", () => {
	const colors = BUILTIN_THEMES[0]!.colors;
	const source = { themeFiles: () => [
		{ pluginId: "graphite", file: "Graphite Dark.json", text: JSON.stringify({ name: "Graphite", mode: "dark", colors }) },
		{ pluginId: "graphite", file: "broken.json", text: "{" },
		{ pluginId: "graphite", file: "invalid.json", text: JSON.stringify({ name: "Bad", mode: "dark", colors: { ...colors, background: "red" } }) },
	] };
	const themes = listPluginThemes(source);
	assert.deepEqual(themes.map(theme => [theme.id, theme.plugin, theme.builtin]), [["graphite-graphite-dark", "graphite", false]]);
	assert.equal(pluginThemeId("p", "x.json"), "p-x");
	assert.equal(readPluginTheme(source, "graphite-graphite-dark")?.name, "Graphite");
	assert.equal(readPluginTheme(undefined, "graphite-graphite-dark"), null);
	assert.equal(resolveTheme("graphite-graphite-dark", themes).id, "graphite-graphite-dark");
	// Disabled plugin: no theme files → the selection renders as Default.
	assert.equal(resolveTheme("graphite-graphite-dark", listPluginThemes({ themeFiles: () => [] })).id, "default");
});
