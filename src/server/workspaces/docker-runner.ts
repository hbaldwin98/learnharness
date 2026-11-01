/**
 * THE DOCKER RUNNER (plan steps 2 and 2b) — implements the agent layer's
 * CodeRunner port over the Docker Engine API with dockerode (owner
 * ruling 2b: the CLI cost ~400 ms per process start on Windows, five per
 * run). The engine is found by docker-engine.ts (DOCKER_HOST → current
 * context → platform default).
 *
 * Images: built locally from docker/workspace-code/<image>/, tagged by a
 * hash of that directory; a rebuild deletes the superseded tag. Kept
 * until removed (owner ruling).
 *
 * Containers: one warm, locked-down container per active problem (no
 * network, read-only root, tmpfs /work and /tmp, uid 1000, 2 GiB, 2 CPUs,
 * 256 pids, no capabilities, no-new-privileges), auto-removed when
 * stopped. Files enter by a tar stream on an exec's stdin — nothing is
 * mounted, and the archive API can't write into a tmpfs mount. Each run
 * uses a freshly wiped /work/run and wipes it afterwards. Containers are
 * removed on conclude and dismissal (reconcile), after 30 minutes idle,
 * and at startup.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import Docker from "dockerode";
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
import { dockerInstalled, resolveEngine } from "./docker-engine.ts";
import { tarFiles, type TarEntry } from "./tar.ts";

export const WORKSPACE_LABEL = "learnharness.workspace";
const LABEL_VALUE = "code";
const CHAT_LABEL = "learnharness.chat";
const PROBLEM_LABEL = "learnharness.problem";
const IMAGE_DIR = path.join(PATHS.root, "docker", "workspace-code");
const STATUS_TTL_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;
const IDLE_MS = 30 * 60_000;
/** Reports and stdout-reported test streams may be larger than shown output. */
const REPORT_CAP_BYTES = 2 * 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

// ─── images ──────────────────────────────────────────────────────────────────

/** Every file in a directory, relative paths with forward slashes, sorted. */
function contextFiles(dir: string): Array<{ path: string; content: Buffer }> {
	const out: Array<{ path: string; content: Buffer }> = [];
	const walk = (d: string) => {
		for (const name of fs.readdirSync(d).sort()) {
			const full = path.join(d, name);
			if (fs.statSync(full).isDirectory()) walk(full);
			else out.push({ path: path.relative(dir, full).split(path.sep).join("/"), content: fs.readFileSync(full) });
		}
	};
	walk(dir);
	return out;
}

/** The image tag: a hash of every file in the image's directory. */
export function imageTag(image: CodeImage, dir = path.join(IMAGE_DIR, image)): string {
	const hash = createHash("sha256");
	for (const file of contextFiles(dir)) hash.update(file.path).update("\0").update(file.content).update("\0");
	return `learnharness-code-${image}:${hash.digest("hex").slice(0, 12)}`;
}

// ─── containers ──────────────────────────────────────────────────────────────

/** Docker names allow [a-zA-Z0-9][a-zA-Z0-9_.-]; keep ids readable and short. */
const safe = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 60);
export const containerName = (key: ProblemKey) => `lh-code-${safe(key.chatId)}-${safe(key.problemCallId)}`;

const statusCode = (error: unknown) => (error as { statusCode?: number } | null)?.statusCode;

interface ExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** A byte-capped text sink. */
function sink(cap: number): { stream: Writable; text: () => string } {
	const chunks: Buffer[] = [];
	let size = 0;
	return {
		stream: new Writable({
			write(chunk: Buffer, _encoding, callback) {
				if (size < cap) {
					chunks.push(chunk);
					size += chunk.length;
				}
				callback();
			},
		}),
		text: () => Buffer.concat(chunks).toString("utf8"),
	};
}

/** Run one command in a container: stdout/stderr split, exit code from
 *  the exec's inspect, optional stdin, host-side timeout backstop. */
async function exec(
	container: Docker.Container,
	modem: Docker.Modem,
	cmd: string[],
	opts: { stdin?: Buffer; workingDir?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
	const created = await container.exec({
		Cmd: cmd,
		AttachStdin: Boolean(opts.stdin),
		AttachStdout: true,
		AttachStderr: true,
		Tty: false,
		...(opts.workingDir ? { WorkingDir: opts.workingDir } : {}),
	});
	const stream = await created.start({ hijack: true, stdin: Boolean(opts.stdin) });
	const out = sink(REPORT_CAP_BYTES);
	const err = sink(REPORT_CAP_BYTES);
	modem.demuxStream(stream, out.stream, err.stream);
	let timedOut = false;
	await new Promise<void>((resolve, reject) => {
		const timer = opts.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					stream.destroy();
				}, opts.timeoutMs)
			: null;
		const onAbort = () => stream.destroy();
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		const done = () => {
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			if (opts.signal?.aborted) reject(opts.signal.reason ?? new Error("aborted"));
			else resolve();
		};
		stream.on("end", done);
		stream.on("close", done);
		stream.on("error", (error) => (timedOut || opts.signal?.aborted ? done() : reject(error)));
		if (opts.stdin) stream.end(opts.stdin);
	});
	if (timedOut) return { code: null, stdout: out.text(), stderr: err.text(), timedOut: true };
	// The stream can end a moment before the engine records the exit:
	// poll until the exec is no longer running (bounded).
	let info = await created.inspect();
	for (let i = 0; info.Running && i < 100; i++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		info = await created.inspect();
	}
	return { code: info.Running ? null : info.ExitCode, stdout: out.text(), stderr: err.text(), timedOut: false };
}

/** Extract the tar on stdin into `dir`, then stamp exactly the extracted
 *  files with the current time at full precision. The tar header holds
 *  whole seconds, so a file rewritten within the second of the last build
 *  could look no newer than that build's outputs: cargo (and MSBuild)
 *  would skip the rebuild and report the previous result, and Eclipse
 *  (jdtls) would keep the old text. */
export const extractFresh = (dir: string) =>
	`list=$(mktemp) && tar -x -v -C ${dir} > "$list" && (cd ${dir} && xargs -r -d '\\n' touch -c -- < "$list"); s=$?; rm -f "$list"; exit $s`;

const isTimeout = (r: ExecResult) => r.timedOut || r.code === 124 || r.code === 137;

export interface DockerRunnerOptions {
	/** Idle removal sweep (tests disable it). */
	sweep?: boolean;
	/** A container was removed for idleness (its language server must stop
	 *  too, or its restart would bring the container back). */
	onIdleRemoved?: (key: ProblemKey) => void;
}

export function createDockerRunner(options: DockerRunnerOptions = {}): CodeRunner & {
	reapAll(): Promise<void>;
	retainOnly(chatId: string, activeProblemCallId: string | null): Promise<void>;
} {
	let client: Docker | null = null;
	/** The engine client; re-resolved after a failed ping (the context may change). */
	const docker = () => (client ??= new Docker(resolveEngine().options));
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

	/** Force-remove by name; a missing or already-removing container is fine. */
	async function removeByName(name: string): Promise<void> {
		lastUsed.delete(name);
		await docker().getContainer(name).remove({ force: true }).catch(() => {});
	}

	const remove = (key: ProblemKey) => removeByName(containerName(key));

	if (options.sweep !== false) {
		setInterval(() => {
			const now = Date.now();
			for (const [name, entry] of lastUsed) {
				if (now - entry.at <= IDLE_MS) continue;
				options.onIdleRemoved?.(entry.key);
				void removeByName(name);
			}
		}, 5 * 60_000).unref();
	}

	async function ensureContainer(key: ProblemKey, tag: string): Promise<Docker.Container> {
		const name = containerName(key);
		const existing = docker().getContainer(name);
		try {
			if ((await existing.inspect()).State.Running) return existing;
			await existing.remove({ force: true }).catch(() => {});
		} catch (error) {
			if (statusCode(error) !== 404) throw error;
		}
		const container = await docker().createContainer({
			name,
			Image: tag,
			Cmd: ["sleep", "infinity"],
			User: "1000:1000",
			Labels: { [WORKSPACE_LABEL]: LABEL_VALUE, [CHAT_LABEL]: key.chatId, [PROBLEM_LABEL]: key.problemCallId },
			HostConfig: {
				AutoRemove: true,
				NetworkMode: "none",
				ReadonlyRootfs: true,
				Tmpfs: { "/work": "rw,exec,nosuid,size=768m,mode=1777", "/tmp": "rw,exec,nosuid,size=256m,mode=1777" },
				Memory: 2 * GIB,
				MemorySwap: 2 * GIB,
				NanoCpus: 2_000_000_000,
				PidsLimit: 256,
				SecurityOpt: ["no-new-privileges"],
				CapDrop: ["ALL"],
			},
		});
		await container.start();
		return container;
	}

	return {
		async status() {
			if (status && Date.now() - status.at < STATUS_TTL_MS) return status.value;
			let value: DockerStatus;
			if (!dockerInstalled()) value = "missing";
			else {
				const ping = docker().ping().then(() => true, () => false);
				const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PING_TIMEOUT_MS).unref());
				value = (await Promise.race([ping, timeout])) ? "running" : "stopped";
				if (value === "stopped") client = null; // re-resolve the endpoint next time
			}
			status = { value, at: Date.now() };
			return value;
		},

		ensureImage(image, onProgress, signal) {
			const tag = imageTag(image);
			const inFlight = builds.get(tag);
			if (inFlight) return inFlight;
			const build = (async (): Promise<ImageResult> => {
				try {
					await docker().getImage(tag).inspect();
					return { ok: true };
				} catch (error) {
					if (statusCode(error) !== 404) throw error;
				}
				onProgress?.(`building the ${image} environment (first use — this takes a few minutes)`);
				const context: TarEntry[] = contextFiles(path.join(IMAGE_DIR, image));
				const stream = await docker().buildImage(Readable.from([tarFiles(context)]), {
					t: tag,
					labels: { [WORKSPACE_LABEL]: LABEL_VALUE },
					rm: true,
					forcerm: true,
					...(signal ? { abortSignal: signal } : {}),
				});
				const log: string[] = [];
				let failure: string | null = null;
				await new Promise<void>((resolve, reject) => {
					docker().modem.followProgress(
						stream,
						(error) => (error ? reject(error) : resolve()),
						(event) => {
							if (event.stream) {
								log.push(event.stream);
								const step = /^Step \d+\/\d+ : (.*)$/m.exec(event.stream);
								if (step) onProgress?.(`building the ${image} environment: ${step[0]!.slice(0, 160)}`);
							}
							if (event.error) failure = event.errorDetail?.message ?? event.error;
						},
					);
				});
				if (failure !== null) return { ok: false, output: capOutput(`${log.join("")}\n${failure}`, OUTPUT_CAP_BYTES) };
				// Delete superseded tags of this image (cleanup, owner 2026-11-01).
				const images = await docker().listImages({ filters: { label: [`${WORKSPACE_LABEL}=${LABEL_VALUE}`] } });
				for (const old of images.flatMap((i) => i.RepoTags ?? [])) {
					if (old.startsWith(`learnharness-code-${image}:`) && old !== tag) await docker().getImage(old).remove().catch(() => {});
				}
				return { ok: true };
			})().finally(() => builds.delete(tag));
			builds.set(tag, build);
			return build;
		},

		run({ key, image, files, steps, report, signal }) {
			const name = containerName(key);
			return withLock(name, async (): Promise<RunOutcome> => {
				const container = await ensureContainer(key, imageTag(image));
				const modem = docker().modem;
				lastUsed.set(name, { key, at: Date.now() });
				const sig = signal ? { signal } : {};
				try {
					const prepared = await exec(container, modem, ["sh", "-c", "rm -rf /work/run && mkdir -p /work/run && cp -a /opt/scaffold/. /work/run/"], { timeoutMs: 30_000, ...sig });
					if (prepared.code !== 0) throw new Error(`could not prepare the run: ${prepared.stderr.trim()}`);
					const copied = await exec(container, modem, ["sh", "-c", extractFresh("/work/run")], { stdin: tarFiles(files), timeoutMs: 30_000, ...sig });
					if (copied.code !== 0) throw new Error(`could not copy the files: ${copied.stderr.trim()}`);

					const outcomes: StepOutcome[] = [];
					let lastStdout = "";
					for (const step of steps) {
						const seconds = Math.ceil(step.timeoutMs / 1000);
						const result = await exec(container, modem, ["timeout", "-k", "2", String(seconds), "sh", "-c", step.command], {
							workingDir: "/work/run",
							timeoutMs: step.timeoutMs + 15_000,
							...sig,
						});
						lastStdout = result.stdout;
						const timedOut = isTimeout(result);
						outcomes.push({
							phase: step.phase,
							exitCode: result.code,
							timedOut,
							output: capOutput([result.stdout, result.stderr].filter((s) => s.trim()).join("\n"), OUTPUT_CAP_BYTES),
						});
						if (step.phase === "build" && (result.code !== 0 || timedOut)) break;
						if (result.timedOut) {
							// The host-side backstop fired: the command may still be running inside.
							await remove(key);
							return { steps: outcomes, report: null };
						}
						if (timedOut) break;
					}

					let reportText: string | null = null;
					const ranTests = outcomes.at(-1)?.phase === "test";
					if (ranTests && report === null) reportText = lastStdout;
					else if (ranTests && report !== null) {
						const read = await exec(container, modem, ["cat", report], { workingDir: "/work/run", timeoutMs: 30_000, ...sig });
						reportText = read.code === 0 ? read.stdout : null;
					}
					return { steps: outcomes, report: reportText };
				} finally {
					if (lastUsed.has(name)) {
						lastUsed.set(name, { key, at: Date.now() });
						await exec(container, modem, ["rm", "-rf", "/work/run"], { timeoutMs: 30_000 }).catch(() => {});
					}
				}
			});
		},

		remove,

		async writeFiles({ key, image, dir, files, fresh }) {
			const name = containerName(key);
			const container = await ensureContainer(key, imageTag(image));
			lastUsed.set(name, { key, at: Date.now() });
			const modem = docker().modem;
			if (fresh) {
				const prepared = await exec(
					container,
					modem,
					["sh", "-c", `rm -rf ${dir} && mkdir -p ${dir} /work/.home && cp -a /opt/scaffold/. ${dir}/`],
					{ timeoutMs: 30_000 },
				);
				if (prepared.code !== 0) throw new Error(`could not prepare ${dir}: ${prepared.stderr.trim()}`);
			}
			const copied = await exec(container, modem, ["sh", "-c", extractFresh(dir)], { stdin: tarFiles(files), timeoutMs: 30_000 });
			if (copied.code !== 0) throw new Error(`could not copy the files: ${copied.stderr.trim()}`);
		},

		async spawn({ key, image, command, workingDir }) {
			const name = containerName(key);
			const container = await ensureContainer(key, imageTag(image));
			lastUsed.set(name, { key, at: Date.now() });
			const created = await container.exec({
				Cmd: ["sh", "-c", command],
				AttachStdin: true,
				AttachStdout: true,
				AttachStderr: true,
				Tty: false,
				WorkingDir: workingDir,
			});
			const stream = await created.start({ hijack: true, stdin: true });
			const stdout = new PassThrough();
			// stderr is the server's own log: drained, never shown.
			const stderr = new Writable({ write: (_c, _e, cb) => cb() });
			docker().modem.demuxStream(stream, stdout, stderr);
			const exited = new Promise<void>((resolve) => {
				const done = () => {
					stdout.end();
					resolve();
				};
				stream.on("end", done);
				stream.on("close", done);
				stream.on("error", done);
			});
			const stdin = new Writable({
				write(chunk, _encoding, callback) {
					stream.write(chunk, callback);
				},
				final(callback) {
					stream.end();
					callback();
				},
			});
			return {
				stdin,
				stdout,
				exited,
				kill: () => stream.destroy(),
			};
		},

		/** Remove every workspace container (server startup). */
		async reapAll() {
			const containers = await docker()
				.listContainers({ all: true, filters: { label: [`${WORKSPACE_LABEL}=${LABEL_VALUE}`] } })
				.catch(() => []);
			await Promise.all(containers.map((c) => docker().getContainer(c.Id).remove({ force: true }).catch(() => {})));
			lastUsed.clear();
		},

		/** Remove the chat's containers except the active problem's
		 *  (conclude and dismissal both end in this reconcile). */
		async retainOnly(chatId, activeProblemCallId) {
			const containers = await docker()
				.listContainers({ all: true, filters: { label: [`${CHAT_LABEL}=${chatId}`] } })
				.catch(() => []);
			for (const c of containers) {
				if (c.Labels[PROBLEM_LABEL] === activeProblemCallId) continue;
				const name = (c.Names[0] ?? "").replace(/^\//, "");
				lastUsed.delete(name);
				await docker().getContainer(c.Id).remove({ force: true }).catch(() => {});
			}
		},
	};
}
