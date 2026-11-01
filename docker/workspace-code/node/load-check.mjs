// Load every non-test source module in the run directory, so syntax and
// import errors surface without running the tests. Exit 1 on any failure.
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const files = [];
(function walk(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full);
		else if (/\.(js|mjs|ts|mts)$/.test(entry.name) && !/\.test\.(js|mjs|ts|mts)$/.test(entry.name)) files.push(full);
	}
})(root);

let failed = false;
for (const file of files.sort()) {
	try {
		await import(pathToFileURL(file).href);
	} catch (error) {
		failed = true;
		console.error(`${relative(root, file)}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	}
}
process.exit(failed ? 1 : 0);
