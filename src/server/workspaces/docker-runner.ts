/**
 * THE DOCKER CLI RUNNER (plan step 2) — implements the agent layer's
 * CodeRunner port by spawning the `docker` CLI (owner ruling: no Engine
 * API dependency).
 *
 * Images: built locally from docker/workspace-code/<image>/, tagged by a
 * hash of that directory; a rebuild deletes the superseded tag. Kept
 * until removed (owner ruling).
 *
 * Containers: one warm, locked-down container per active problem
 * (no network, read-only root, tmpfs /work and /tmp, uid 1000, 1 GB,
 * 2 CPUs, 256 pids, no capabilities), started with --rm. Files enter by a
 * tar stream on stdin — nothing is mounted. Each run uses a freshly wiped
 * /work/run and wipes it afterwards. Containers are removed on conclude
 * and dismissal (reconcile), after 30 minutes idle, and at startup.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../../config.ts";
import type { CodeImage } from "../../agent/workspaces/code/languages.ts";
import {
	OUTPUT_CAP_BYTES,
	capOutput,
	type CodeRunner,
	type DockerStatus,
	type ImageResult,
	type ProblemKey,
	type RunOutcome,
	type StepOutcome,
} from "../../agent/workspaces/code/runner.ts";
import { tarFiles } from "./tar.ts";

export const WORKSPACE_LABEL = "learnharness.workspace";
const LABEL_VALUE = "code";
const CHAT_LABEL = "learnharness.chat";
const PROBLEM_LABEL = "learnharness.problem";
const IMAGE_DIR = path.join(PATHS.root, "docker", "workspace-code");
const STATUS_TTL_MS = 30_000;
const IDLE_MS = 30 * 60_000;
/** Reports and stdout-reported test streams may be larger than shown output. */
const REPORT_CAP_BYTES = 2 * 1024 * 1024;

// ─── the docker binary ───────────────────────────────────────────────────────

/** Where Docker Desktop installs its CLI when PATH (e.g. a GUI-launched
 *  Electron app on macOS) doesn't carry it. */
function knownDockerPaths(): string[] {
	if (process.platform === "win32") {
		const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
		return [path.join(programFiles, "Docker", "Docker", "resources", "bin", "docker.exe")];
	}
	return ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker", "/usr/bin/docker"];
}

let resolvedBinary: string | null | undefined;
function dockerBinary(): string | null {
	if (resolvedBinary !== undefined) return resolvedBinary;
	const names = process.platform === "win32" ? ["docker.exe"] : ["docker"];
	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	for (const dir of dirs) {
		for (const name of names) {
			const candidate = path.join(dir, name);
			if (fs.existsSync(candidate)) return (resolvedBinary = candidate);
		}
	}
	return (resolvedBinary = knownDockerPaths().find((p) => fs.existsSync(p)) ?? null);
}

interface DockerResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** Run one docker command. stdout/stderr are each capped at `capBytes`. */
function docker(
	args: readonly string[],
	opts: { stdin?: Buffer; timeoutMs?: number; signal?: AbortSignal; onStderrLine?: (line: string) => void; capBytes?: number } = {},
): Promise<DockerResult> {
	const binary = dockerBinary();
	if (!binary) return Promise.resolve({ code: null, stdout: "", stderr: "docker not found", timedOut: false });
	const cap = opts.capBytes ?? REPORT_CAP_BYTES;
	return new Promise((resolve, reject) => {
		const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let partial = "";
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < cap) stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			if (stderr.length < cap) stderr += text;
			if (opts.onStderrLine) {
				const lines = (partial + text).split(/\r?\n/);
				partial = lines.pop() ?? "";
				for (const line of lines) if (line.trim()) opts.onStderrLine(line);
			}
		});
		const timer = opts.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					child.kill();
				}, opts.timeoutMs)
			: null;
		const onAbort = () => child.kill();
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (error) => {
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			if (opts.signal?.aborted) return reject(opts.signal.reason ?? new Error("aborted"));
			resolve({ code, stdout, stderr, timedOut });
		});
		child.stdin.on("error", () => {}); // the process may exit before reading everything
		child.stdin.end(opts.stdin ?? undefined);
	});
}

// ─── images ──────────────────────────────────────────────────────────────────

/** Hash every file in the image's directory (names + contents). */
export function imageTag(image: CodeImage, dir = path.join(IMAGE_DIR, image)): string {
	const hash = createHash("sha256");
	const walk = (d: string) => {
		for (const name of fs.readdirSync(d).sort()) {
			const full = path.join(d, name);
			if (fs.statSync(full).isDirectory()) walk(full);
			else hash.update(path.relative(dir, full).split(path.sep).join("/")).update("\0").update(fs.readFileSync(full)).update("\0");
		}
	};
	walk(dir);
	return `learnharness-code-${image}:${hash.digest("hex").slice(0, 12)}`;
}

// ─── containers ──────────────────────────────────────────────────────────────

/** Docker names allow [a-zA-Z0-9][a-zA-Z0-9_.-]; keep ids readable and short. */
const safe = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 60);
export const containerName = (key: ProblemKey) => `lh-code-${safe(key.chatId)}-${safe(key.problemCallId)}`;

const isTimeout = (r: DockerResult) => r.timedOut || r.code === 124 || r.code === 137;

export interface DockerRunnerOptions {
	/** Idle removal sweep (tests disable it). */
	sweep?: boolean;
}

export function createDockerRunner(options: DockerRunnerOptions = {}): CodeRunner & {
	reapAll(): Promise<void>;
	retainOnly(chatId: string, activeProblemCallId: string | null): Promise<void>;
} {
	let status: { value: DockerStatus; at: number } | null = null;
	const builds = new Map<string, Promise<ImageResult>>();
	const lastUsed = new Map<string, { key: ProblemKey; at: number }>();
	const locks = new Map<string, Promise<unknown>>();

	/** Serialize runs per container (one /work/run at a time). */
	function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
		const previous = locks.get(name) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(fn);
		locks.set(name, next);
		return next.finally(() => {
			if (locks.get(name) === next) locks.delete(name);
		});
	}

	async function remove(key: ProblemKey): Promise<void> {
		const name = containerName(key);
		lastUsed.delete(name);
		await docker(["rm", "-f", name], { timeoutMs: 30_000 }).catch(() => {});
	}

	if (options.sweep !== false) {
		setInterval(() => {
			const now = Date.now();
			for (const [, entry] of lastUsed) if (now - entry.at > IDLE_MS) void remove(entry.key);
		}, 5 * 60_000).unref();
	}

	async function ensureContainer(key: ProblemKey, tag: string): Promise<string> {
		const name = containerName(key);
		const inspect = await docker(["container", "inspect", "-f", "{{.State.Running}}", name], { timeoutMs: 15_000 });
		if (inspect.code === 0 && inspect.stdout.trim() === "true") return name;
		if (inspect.code === 0) await docker(["rm", "-f", name], { timeoutMs: 30_000 });
		const started = await docker(
			[
				"run", "-d", "--rm", "--name", name,
				"--label", `${WORKSPACE_LABEL}=${LABEL_VALUE}`,
				"--label", `${CHAT_LABEL}=${key.chatId}`,
				"--label", `${PROBLEM_LABEL}=${key.problemCallId}`,
				"--network", "none",
				"--read-only",
				"--tmpfs", "/work:rw,exec,nosuid,size=768m,mode=1777",
				"--tmpfs", "/tmp:rw,exec,nosuid,size=256m,mode=1777",
				"--user", "1000:1000",
				"--memory", "1g", "--memory-swap", "1g",
				"--cpus", "2",
				"--pids-limit", "256",
				"--security-opt", "no-new-privileges",
				"--cap-drop", "ALL",
				tag, "sleep", "infinity",
			],
			{ timeoutMs: 60_000 },
		);
		if (started.code !== 0) throw new Error(`could not start the container: ${started.stderr.trim() || started.stdout.trim()}`);
		return name;
	}

	return {
		async status() {
			if (status && Date.now() - status.at < STATUS_TTL_MS) return status.value;
			let value: DockerStatus;
			if (!dockerBinary()) value = "missing";
			else {
				const info = await docker(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 15_000 }).catch(() => null);
				value = info && info.code === 0 && info.stdout.trim() ? "running" : "stopped";
			}
			status = { value, at: Date.now() };
			return value;
		},

		ensureImage(image, onProgress, signal) {
			const tag = imageTag(image);
			const inFlight = builds.get(tag);
			if (inFlight) return inFlight;
			const build = (async (): Promise<ImageResult> => {
				const present = await docker(["image", "inspect", "--format", "{{.Id}}", tag], { timeoutMs: 30_000 });
				if (present.code === 0) return { ok: true };
				onProgress?.(`building the ${image} environment (first use — this takes a few minutes)`);
				const built = await docker(
					["build", "--progress=plain", "--label", `${WORKSPACE_LABEL}=${LABEL_VALUE}`, "-t", tag, path.join(IMAGE_DIR, image)],
					{
						...(signal ? { signal } : {}),
						capBytes: OUTPUT_CAP_BYTES * 4,
						onStderrLine: (line) => {
							// BuildKit plain lines: "#7 [3/4] RUN …", "#7 12.3 output".
							const step = /^#\d+ (\[[^\]]+\] .*)$/.exec(line);
							if (step) onProgress?.(`building the ${image} environment: ${step[1]!.slice(0, 160)}`);
						},
					},
				);
				if (built.code !== 0) return { ok: false, output: capOutput(built.stderr || built.stdout, OUTPUT_CAP_BYTES) };
				// Delete superseded tags of this image (cleanup, owner 2026-11-01).
				const listed = await docker(["images", "--filter", `reference=learnharness-code-${image}`, "--format", "{{.Repository}}:{{.Tag}}"], { timeoutMs: 30_000 });
				for (const old of listed.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== tag)) {
					await docker(["rmi", old], { timeoutMs: 60_000 }).catch(() => {});
				}
				return { ok: true };
			})().finally(() => builds.delete(tag));
			builds.set(tag, build);
			return build;
		},

		run({ key, image, files, steps, report, signal }) {
			const name = containerName(key);
			return withLock(name, async (): Promise<RunOutcome> => {
				const tag = imageTag(image);
				await ensureContainer(key, tag);
				lastUsed.set(name, { key, at: Date.now() });
				const sig = signal ? { signal } : {};
				try {
					const prepared = await docker(
						["exec", name, "sh", "-c", "rm -rf /work/run && mkdir -p /work/run && cp -a /opt/scaffold/. /work/run/"],
						{ timeoutMs: 30_000, ...sig },
					);
					if (prepared.code !== 0) throw new Error(`could not prepare the run: ${prepared.stderr.trim()}`);
					const copied = await docker(["exec", "-i", name, "tar", "-x", "-C", "/work/run"], {
						stdin: tarFiles(files),
						timeoutMs: 30_000,
						...sig,
					});
					if (copied.code !== 0) throw new Error(`could not copy the files: ${copied.stderr.trim()}`);

					const outcomes: StepOutcome[] = [];
					let lastStdout = "";
					for (const step of steps) {
						const seconds = Math.ceil(step.timeoutMs / 1000);
						const result = await docker(
							["exec", "-w", "/work/run", name, "timeout", "-k", "2", String(seconds), "sh", "-c", step.command],
							{ timeoutMs: step.timeoutMs + 15_000, ...sig },
						);
						lastStdout = result.stdout;
						const timedOut = isTimeout(result);
						outcomes.push({
							phase: step.phase,
							exitCode: result.code,
							timedOut,
							output: capOutput([result.stdout, result.stderr].filter((s) => s.trim()).join("\n"), OUTPUT_CAP_BYTES),
						});
						if (step.phase === "build" && (result.code !== 0 || timedOut)) break;
						if (timedOut) {
							// The host-side backstop fired: the exec may still be running inside.
							await remove(key);
							return { steps: outcomes, report: null };
						}
					}

					let reportText: string | null = null;
					const ranTests = outcomes.at(-1)?.phase === "test";
					if (ranTests && report === null) reportText = lastStdout;
					else if (ranTests && report !== null) {
						const read = await docker(["exec", "-w", "/work/run", name, "cat", report], { timeoutMs: 30_000, ...sig });
						reportText = read.code === 0 ? read.stdout : null;
					}
					return { steps: outcomes, report: reportText };
				} finally {
					lastUsed.set(name, { key, at: Date.now() });
					await docker(["exec", name, "rm", "-rf", "/work/run"], { timeoutMs: 30_000 }).catch(() => {});
				}
			});
		},

		remove,

		/** Remove every workspace container (server startup). */
		async reapAll() {
			const listed = await docker(["ps", "-aq", "--filter", `label=${WORKSPACE_LABEL}=${LABEL_VALUE}`], { timeoutMs: 30_000 }).catch(() => null);
			const ids = listed?.stdout.split(/\s+/).filter(Boolean) ?? [];
			if (ids.length > 0) await docker(["rm", "-f", ...ids], { timeoutMs: 60_000 }).catch(() => {});
			lastUsed.clear();
		},

		/** Remove the chat's containers except the active problem's
		 *  (conclude and dismissal both end in this reconcile). */
		async retainOnly(chatId, activeProblemCallId) {
			const listed = await docker(
				["ps", "-a", "--filter", `label=${CHAT_LABEL}=${chatId}`, "--format", `{{.Names}}\t{{.Label "${PROBLEM_LABEL}"}}`],
				{ timeoutMs: 30_000 },
			).catch(() => null);
			for (const line of listed?.stdout.split(/\r?\n/) ?? []) {
				const [name, problem] = line.split("\t");
				if (!name || problem === activeProblemCallId) continue;
				lastUsed.delete(name.trim());
				await docker(["rm", "-f", name.trim()], { timeoutMs: 30_000 }).catch(() => {});
			}
		},
	};
}
