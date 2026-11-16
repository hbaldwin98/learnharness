import fs from "node:fs";
import path from "node:path";

export const READ_CAP = 64 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "target", "bin", "obj", "build", "dist", ".gradle"]);
const LIST_MAX = 2000;

/**
 * Resolve a project-relative path to an absolute host path inside the project folder.
 * Rejects absolute paths, `..` escapes, and symlinks that point outside the folder.
 */
export function resolveInside(root: string, relative: string): string {
	const cleaned = relative.replace(/\\/g, "/").replace(/^\/work(\/|$)/, "").replace(/^(\.\/)+/, "");
	if (path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) throw new Error("Use a path relative to the project folder");
	const rootReal = fs.realpathSync(root);
	const target = path.resolve(rootReal, cleaned || ".");
	const inside = (p: string) => p === rootReal || p.startsWith(rootReal + path.sep);
	if (!inside(target)) throw new Error("That path is outside the project");
	// Follow symlinks for existing paths (and the nearest existing parent otherwise).
	let probe = target;
	while (!fs.existsSync(probe) && probe !== rootReal) probe = path.dirname(probe);
	if (!inside(fs.realpathSync(probe))) throw new Error("That path is outside the project");
	return target;
}

export const toRelative = (root: string, absolute: string) => path.relative(fs.realpathSync(root), absolute).split(path.sep).join("/");

/** Files under the folder (relative, forward slashes), skipping VCS/dependency/build dirs. */
export function walkFiles(root: string, under = ""): { files: string[]; truncated: boolean } {
	const start = resolveInside(root, under);
	const out: string[] = [];
	let truncated = false;
	const walk = (dir: string) => {
		if (out.length >= LIST_MAX) { truncated = true; return; }
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(full); }
			else if (entry.isFile()) {
				if (out.length >= LIST_MAX) { truncated = true; return; }
				out.push(toRelative(root, full));
			}
		}
	};
	walk(start);
	return { files: out, truncated };
}

/** A text file's content (capped); binary files are refused. */
export function readText(root: string, relative: string): { content: string; truncated: boolean; size: number } {
	const file = resolveInside(root, relative);
	const stat = fs.statSync(file);
	if (!stat.isFile()) throw new Error("Not a file");
	const fd = fs.openSync(file, "r");
	try {
		const buffer = Buffer.alloc(Math.min(stat.size, READ_CAP));
		fs.readSync(fd, buffer, 0, buffer.length, 0);
		if (buffer.includes(0)) throw new Error("That file looks binary");
		return { content: buffer.toString("utf8"), truncated: stat.size > READ_CAP, size: stat.size };
	} finally {
		fs.closeSync(fd);
	}
}

/** Number lines for the tutor ("  12│ code"). */
export function numbered(content: string, from = 1): string {
	const lines = content.split("\n");
	const width = String(from + lines.length - 1).length;
	return lines.map((line, i) => `${String(from + i).padStart(width)}│ ${line}`).join("\n");
}
