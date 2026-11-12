import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
try {
  if (fs.lstatSync(output).isSymbolicLink()) throw new Error("Refusing to build into a linked directory.");
  try { fs.lstatSync(path.join(output, "data")); throw new Error("Refusing to build over plugin data. Move it to a safe location first."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
} catch (error) { if (error.code !== "ENOENT") throw error; }
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
const common = { bundle: true, target: "es2022", minify: true, legalComments: "eof", logLevel: "warning", absWorkingDir: root };
await build({ ...common, entryPoints: { main: "src/main.ts" }, outdir: output, format: "esm", platform: "browser" });
// ssh2 (dockerode's SSH transport) loads optional native accelerators inside
// try/catch; leave them unresolved so the pure-JS fallbacks are used.
const backend = await build({
  ...common, entryPoints: ["src/backend.ts"], outfile: path.join(output, "backend.cjs"), format: "cjs", platform: "node", metafile: true,
  external: ["cpu-features", "*.node"],
});
for (const [from, to] of [["manifest.json", "manifest.json"], ["src/styles.css", "styles.css"], ["README.md", "README.md"], ["LICENSE", "LICENSE"]]) {
  fs.copyFileSync(path.join(root, from), path.join(output, to));
}
// The sandbox images' build contexts, read by the backend at run time.
fs.cpSync(path.join(root, "docker"), path.join(output, "docker"), { recursive: true });
// Attribution for every package bundled into the backend.
const packages = new Map();
for (const input of Object.keys(backend.metafile.inputs)) {
  if (!input.includes("node_modules/")) continue;
  let directory = path.dirname(path.resolve(root, input));
  while (directory !== path.dirname(directory)) {
    const manifest = path.join(directory, "package.json");
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (pkg.name) {
        const licenses = fs.readdirSync(directory).filter(name => /^(licen[sc]e|copying)(\.|$)/i.test(name));
        packages.set(`${pkg.name}@${pkg.version}`, `${pkg.name}@${pkg.version} (${pkg.license ?? "see license"})\n${licenses.map(name => fs.readFileSync(path.join(directory, name), "utf8")).join("\n")}`);
        break;
      }
    }
    directory = path.dirname(directory);
  }
}
fs.writeFileSync(path.join(output, "THIRD-PARTY-LICENSES.txt"), [...packages.values()].join("\n\n----------------------------------------\n\n") + "\n");
console.log(`Built ${output}`);
