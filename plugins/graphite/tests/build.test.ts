import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

describe("graphite package", () => {
  it("builds manifest, styles, main and every font the stylesheet references", () => {
    execFileSync(process.execPath, [path.join(root, "scripts", "build.mjs")], { cwd: root, stdio: "pipe" });
    const dist = path.join(root, "dist");
    for (const file of ["manifest.json", "main.js", "styles.css"]) assert.ok(fs.statSync(path.join(dist, file)).isFile(), file);
    const css = fs.readFileSync(path.join(dist, "styles.css"), "utf8");
    const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map(m => m[1]!);
    assert.ok(urls.length >= 4);
    for (const url of urls) assert.ok(fs.statSync(path.join(dist, url)).isFile(), url);
  });
  it("sets no hard-coded colours outside the shadow ramp", () => {
    const css = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
    for (const rgb of css.match(/rgb\([^)]*\)/g) ?? []) assert.match(rgb, /^rgb\(0 0 0 \/ 0\.\d+\)$/);
  });
  it("ships a valid theme file", () => {
    const theme = JSON.parse(fs.readFileSync(path.join(root, "theme", "graphite.json"), "utf8"));
    assert.equal(theme.mode, "dark");
    assert.equal(Object.keys(theme.colors).length, 12);
  });
});
