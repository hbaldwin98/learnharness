/**
 * GIT SNAPSHOTS of a project folder, on hidden refs that never touch the learner's
 * branches, index or working tree:
 *
 *   refs/learnharness/snapshots/latest  — a chain of snapshot commits
 *   refs/learnharness/looks/<chat>      — the snapshot the tutor last saw in that chat
 *
 * A snapshot stages the whole folder (respecting .gitignore) into a temporary index,
 * writes a tree, and commits it onto the snapshot chain only when the tree changed.
 * Uses the host's git; without git, snapshots are unavailable (not an error).
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SNAPSHOT_REF = "refs/learnharness/snapshots/latest";
const lookRef = (chatId: string) => `refs/learnharness/looks/${createHash("sha256").update(chatId).digest("hex").slice(0, 16)}`;
const IDENTITY = ["-c", "user.name=LearnHarness", "-c", "user.email=learnharness@localhost", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"];
export const DIFF_CAP = 48 * 1024;

const DEFAULT_IGNORE = ["node_modules/", ".venv/", "venv/", "__pycache__/", "*.pyc", "target/", "bin/", "obj/", "build/", "dist/", ".gradle/", ".DS_Store", ""].join("\n");

type Git = (args: string[], opts?: { env?: Record<string, string>; input?: string }) => Promise<string>;

function gitIn(cwd: string): Git {
	return (args, opts = {}) => new Promise((resolve, reject) => {
		const child = execFile("git", [...IDENTITY, ...args], { cwd, env: { ...process.env, ...opts.env }, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
			if (error) reject(new Error(`git ${args[0]}: ${(stderr || error.message).trim()}`));
			else resolve(stdout);
		});
		if (opts.input !== undefined) child.stdin?.end(opts.input);
	});
}

let gitAvailable: Promise<boolean> | null = null;
export function hasGit(): Promise<boolean> {
	return gitAvailable ??= new Promise(resolve => execFile("git", ["--version"], { windowsHide: true }, error => resolve(!error)));
}

export interface ChangesSinceLook {
	/** null when there is no earlier look in this chat (first look: everything is new). */
	from: string | null;
	to: string;
	/** `git diff --stat` style summary. */
	stat: string;
	/** Unified diff, capped at DIFF_CAP characters. */
	diff: string;
	truncated: boolean;
}

export function createSnapshots(hostPath: string) {
	const git = gitIn(hostPath);
	const isRepo = async () => fs.existsSync(path.join(hostPath, ".git")) || (await git(["rev-parse", "--is-inside-work-tree"]).then(o => o.trim() === "true", () => false));
	const resolveRef = (ref: string) => git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then(o => o.trim() || null, () => null);

	return {
		/** Make the folder a git repo (with a starter .gitignore) when it is not one. */
		async ensureRepo(): Promise<void> {
			if (await isRepo()) return;
			await git(["init", "-q"]);
			const ignore = path.join(hostPath, ".gitignore");
			if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, DEFAULT_IGNORE);
		},

		/** Snapshot the folder; returns the snapshot commit (unchanged trees reuse the last one). */
		async snapshot(reason: string): Promise<string> {
			await this.ensureRepo();
			const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-snap-"));
			const env = { GIT_INDEX_FILE: path.join(temp, "index") };
			try {
				await git(["add", "-A", "--", "."], { env });
				const tree = (await git(["write-tree"], { env })).trim();
				const parent = await resolveRef(SNAPSHOT_REF);
				if (parent && (await git(["rev-parse", `${parent}^{tree}`])).trim() === tree) return parent;
				const commit = (await git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `LearnHarness snapshot: ${reason}`])).trim();
				await git(["update-ref", SNAPSHOT_REF, commit]);
				return commit;
			} finally {
				fs.rmSync(temp, { recursive: true, force: true });
			}
		},

		/** Snapshot now and return what changed since the tutor's last look in this chat; marks this as seen. */
		async changesSinceLook(chatId: string, reason: string, opts: { advance?: boolean } = {}): Promise<ChangesSinceLook> {
			const to = await this.snapshot(reason);
			const from = await resolveRef(lookRef(chatId));
			const range = from ? [from, to] : [to];
			// First look: the full tree shown as additions against the empty tree.
			const base = from ? range : ["4b825dc642cb6eb9a060e54bf8d69288fbee4904", to];
			const stat = from === to ? "" : (await git(["diff", "--stat", ...base])).trimEnd();
			let diff = from === to ? "" : await git(["diff", "--no-color", ...base]);
			const truncated = diff.length > DIFF_CAP;
			if (truncated) diff = diff.slice(0, DIFF_CAP);
			if (opts.advance !== false) await git(["update-ref", lookRef(chatId), to]);
			return { from, to, stat, diff, truncated };
		},

		/** Tracked (or not ignored) files in the folder, relative, forward slashes. */
		async files(): Promise<string[]> {
			if (!(await isRepo())) return [];
			const out = await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
			return [...new Set(out.split("\0").filter(Boolean))].sort();
		},
	};
}

export type Snapshots = ReturnType<typeof createSnapshots>;

/** A short text for the tutor describing changes since its last look. */
export function changesText(c: ChangesSinceLook): string {
	if (c.from === c.to) return "No file changes since your last look.";
	const head = c.from ? "Changes since your last look:" : "The project as it stands (your first look):";
	return `${head}\n${c.stat}\n\n\`\`\`diff\n${c.diff}${c.truncated ? "\n… (diff truncated)" : ""}\n\`\`\``;
}
