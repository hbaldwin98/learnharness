/**
 * THE DOCKER RUNNER (ported from the fork's practice workspaces) over the
 * Docker Engine API with dockerode (owner ruling 2b: no CLI). The engine is
 * found by docker-engine.ts (DOCKER_HOST → current context → platform default).
 *
 * Images: built locally from this plugin's docker/<image>/, tagged by a hash of
 * that directory; a rebuild deletes the superseded tag. Kept until removed.
 *
 * Containers: one warm, locked-down container per coding item (no network,
 * read-only root, tmpfs /work and /tmp, uid 1000, 2 GiB, 2 CPUs, 256 pids, no
 * capabilities, no-new-privileges), auto-removed when stopped. Files enter by
 * a tar stream on an exec's stdin — nothing is mounted. Each run uses a freshly
 * wiped /work/run and wipes it afterwards. Containers are removed after 30
 * minutes idle, on deactivation and at activation (orphans).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, Readable, Writable, type Duplex } from "node:stream";
import Docker from "dockerode";
import { CODE_IMAGES, type CodeImage } from "./languages.ts";
import type { CodingTestResult, CodingTests, DockerStatus, ImageInfo } from "../shared/protocol.ts";
import { dockerInstalled, resolveEngine } from "./docker-engine.ts";
import { tarFiles, type TarEntry } from "./tar.ts";

export const WORKSPACE_LABEL = "learnharness.workspace";
const LABEL_VALUE = "code";
const CHAT_LABEL = "learnharness.chat";
const ITEM_LABEL = "learnharness.item";
const STATUS_TTL_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;
const IDLE_MS = 30 * 60_000;
/** coding-questions' limits: 30 s per test process, 64 KiB per stream. */
export const TEST_TIMEOUT_MS = 30_000;
export const STREAM_CAP_BYTES = 64 * 1024;
const GIB = 1024 * 1024 * 1024;

export interface ItemKey {
	chatId: string;
	itemId: string;
}

export interface SpawnedProcess {
	stdin: Writable;
	stdout: Readable;
	exited: Promise<void>;
	kill(): void;
}

export type ImageResult = { ok: true } | { ok: false; output: string };

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
export function imageTag(image: CodeImage, dir: string): string {
	const hash = createHash("sha256");
	for (const file of contextFiles(dir)) hash.update(file.path).update("\0").update(file.content).update("\0");
	return `learnharness-code-${image}:${hash.digest("hex").slice(0, 12)}`;
}

// ─── containers ──────────────────────────────────────────────────────────────

/** Docker names allow [a-zA-Z0-9][a-zA-Z0-9_.-]; keep ids readable and short. */
const safe = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 60);
export const containerName = (key: ItemKey) => `lh-code-${safe(key.chatId)}-${safe(key.itemId)}`;

const statusCode = (error: unknown) => (error as { statusCode?: number } | null)?.statusCode;

export interface ExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	timedOut: boolean;
}

/** A byte-capped sink that keeps whole UTF-8 characters at the cap. */
function sink(cap: number): { stream: Writable; text: () => string; truncated: () => boolean } {
	const chunks: Buffer[] = [];
	let size = 0;
	let truncated = false;
	return {
		stream: new Writable({
			write(chunk: Buffer, _encoding, callback) {
				const room = cap - size;
				if (chunk.length > room) truncated = true;
				if (room > 0) {
					const part = chunk.subarray(0, room);
					chunks.push(part);
					size += part.length;
				}
				callback();
			},
		}),
		text: () => {
			const bytes = Buffer.concat(chunks);
			let end = bytes.length;
			if (truncated && end > 0) {
				let start = end - 1;
				while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start--;
				const lead = bytes[start]!;
				const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
				if (end - start < width) end = start;
			}
			return bytes.subarray(0, end).toString("utf8");
		},
		truncated: () => truncated,
	};
}

/** Run one command in a container: stdout/stderr split, exit code from the
 *  exec's inspect, optional stdin, host-side timeout backstop. */
export async function exec(
	container: Docker.Container,
	modem: Docker.Modem,
	cmd: string[],
	opts: { stdin?: Buffer; workingDir?: string; timeoutMs?: number; signal?: AbortSignal; cap?: number; user?: string } = {},
): Promise<ExecResult> {
	const created = await container.exec({
		Cmd: cmd,
		AttachStdin: Boolean(opts.stdin),
		AttachStdout: true,
		AttachStderr: true,
		Tty: false,
		...(opts.workingDir ? { WorkingDir: opts.workingDir } : {}),
		...(opts.user ? { User: opts.user } : {}),
	});
	const stream = await created.start({ hijack: true, stdin: Boolean(opts.stdin) });
	const out = sink(opts.cap ?? STREAM_CAP_BYTES);
	const err = sink(opts.cap ?? STREAM_CAP_BYTES);
	modem.demuxStream(stream, out.stream, err.stream);
	let timedOut = false;
	await new Promise<void>((resolve, reject) => {
		const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; stream.destroy(); }, opts.timeoutMs) : null;
		const onAbort = () => stream.destroy();
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			if (opts.signal?.aborted) reject(opts.signal.reason ?? new Error("aborted"));
			else resolve();
		};
		stream.on("end", done);
		stream.on("close", done);
		stream.on("error", (error) => (timedOut || opts.signal?.aborted ? done() : (settled = true, reject(error))));
		if (opts.stdin) stream.end(opts.stdin);
	});
	const base = { stdout: out.text(), stderr: err.text(), stdoutTruncated: out.truncated(), stderrTruncated: err.truncated() };
	if (timedOut) return { code: null, ...base, timedOut: true };
	// The stream can end a moment before the engine records the exit: poll (bounded).
	let info = await created.inspect();
	for (let i = 0; info.Running && i < 100; i++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		info = await created.inspect();
	}
	return { code: info.Running ? null : info.ExitCode, ...base, timedOut: false };
}

/** Extract the tar on stdin into `dir`, then stamp the extracted files with
 *  the current time (tar headers hold whole seconds; build tools and language
 *  servers could otherwise see a rewrite as no newer). */
export const extractFresh = (dir: string) =>
	`list=$(mktemp) && tar -x -v -C ${dir} > "$list" && (cd ${dir} && xargs -r -d '\\n' touch -c -- < "$list"); s=$?; rm -f "$list"; exit $s`;

/** Map a container exec of the teacher's recipe to coding-questions' result shape. */
export function recipeResult(r: ExecResult, program: string, image: CodeImage): CodingTestResult {
	const base = { stdout: r.stdout, stderr: r.stderr, stdoutTruncated: r.stdoutTruncated, stderrTruncated: r.stderrTruncated };
	if (r.timedOut || r.code === 124 || r.code === 137) return { status: "error", exitCode: r.code, ...base, message: "Test process exceeded the 30 second timeout" };
	if (r.code === 126 || r.code === 127) return { status: "error", exitCode: r.code, ...base, message: `Could not launch test process: ${program} is not available in the ${image} sandbox` };
	if (r.code === null) return { status: "error", exitCode: null, ...base, message: "Test process exited without an exit code" };
	return { status: r.code === 0 ? "passed" : "failed", exitCode: r.code, ...base };
}

export interface DockerRunnerOptions {
	/** The plugin's docker/ directory (one subdirectory per image). */
	imageRoot: string;
	/** Idle removal sweep (tests disable it). */
	sweep?: boolean;
	/** A container was removed for idleness (its language server must stop too). */
	onIdleRemoved?: (key: ItemKey) => void;
}

export type DockerRunner = ReturnType<typeof createDockerRunner>;

export function createDockerRunner(options: DockerRunnerOptions) {
	let client: Docker | null = null;
	/** The engine client; re-resolved after a failed ping (the context may change). */
	const docker = () => (client ??= new Docker(resolveEngine().options));
	let status: { value: DockerStatus; at: number } | null = null;
	const builds = new Map<string, Promise<ImageResult>>();
	const lastUsed = new Map<string, { key: ItemKey; at: number }>();
	const locks = new Map<string, Promise<unknown>>();
	const tagOf = (image: CodeImage) => imageTag(image, path.join(options.imageRoot, image));

	/** Serialize runs per container (one /work/run at a time). */
	function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
		const previous = locks.get(name) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(fn);
		locks.set(name, next);
		return next.finally(() => { if (locks.get(name) === next) locks.delete(name); });
	}

	async function removeByName(name: string): Promise<void> {
		lastUsed.delete(name);
		await docker().getContainer(name).remove({ force: true }).catch(() => {});
	}
	const remove = (key: ItemKey) => removeByName(containerName(key));

	const sweeper = options.sweep === false ? null : setInterval(() => {
		const now = Date.now();
		for (const [name, entry] of lastUsed) {
			if (now - entry.at <= IDLE_MS) continue;
			options.onIdleRemoved?.(entry.key);
			void removeByName(name);
		}
	}, 5 * 60_000);
	sweeper?.unref();

	async function ensureContainer(key: ItemKey, tag: string): Promise<Docker.Container> {
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
			Labels: { [WORKSPACE_LABEL]: LABEL_VALUE, [CHAT_LABEL]: key.chatId, [ITEM_LABEL]: key.itemId },
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

	async function containerFor(key: ItemKey, image: CodeImage) {
		const container = await ensureContainer(key, tagOf(image));
		lastUsed.set(containerName(key), { key, at: Date.now() });
		return container;
	}

	const runner = {
		/** The engine client (project containers share it). */
		engine: docker,
		/** The current tag for a language image. */
		tagOf,
		async status(): Promise<DockerStatus> {
			if (status && Date.now() - status.at < STATUS_TTL_MS) return status.value;
			let value: DockerStatus;
			if (!dockerInstalled()) value = "missing";
			else {
				const ping = docker().ping().then(() => true, () => false);
				let timer: NodeJS.Timeout | undefined;
				const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS); });
				value = (await Promise.race([ping, timeout])) ? "running" : "stopped";
				clearTimeout(timer);
				if (value === "stopped") client = null;
			}
			status = { value, at: Date.now() };
			return value;
		},

		ensureImage(image: CodeImage, onProgress?: (line: string) => void, signal?: AbortSignal): Promise<ImageResult> {
			const tag = tagOf(image);
			const inFlight = builds.get(tag);
			if (inFlight) return inFlight;
			const build = (async (): Promise<ImageResult> => {
				try {
					await docker().getImage(tag).inspect();
					return { ok: true };
				} catch (error) {
					if (statusCode(error) !== 404) throw error;
				}
				onProgress?.(`Building the ${image} sandbox (first use — this takes a few minutes)`);
				const context: TarEntry[] = contextFiles(path.join(options.imageRoot, image));
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
								if (step) onProgress?.(`Building the ${image} sandbox: ${step[0]!.slice(0, 160)}`);
							}
							if (event.error) failure = event.errorDetail?.message ?? event.error;
						},
					);
				});
				if (failure !== null) return { ok: false, output: `${log.join("").slice(-8000)}\n${failure}` };
				const images = await docker().listImages({ filters: { label: [`${WORKSPACE_LABEL}=${LABEL_VALUE}`] } });
				for (const old of images.flatMap((i) => i.RepoTags ?? [])) {
					if (old.startsWith(`learnharness-code-${image}:`) && old !== tag) await docker().getImage(old).remove().catch(() => {});
				}
				return { ok: true };
			})().finally(() => builds.delete(tag));
			builds.set(tag, build);
			return build;
		},

		/** Run the teacher's recipe: answer.txt in a fresh /work/run, tests.code on
		 *  stdin of `program args`, 30 s limit, 64 KiB per stream. */
		runRecipe({ key, image, answer, tests, signal }: { key: ItemKey; image: CodeImage; answer: string; tests: CodingTests; signal?: AbortSignal }): Promise<CodingTestResult> {
			const name = containerName(key);
			return withLock(name, async () => {
				const container = await containerFor(key, image);
				const modem = docker().modem;
				const sig = signal ? { signal } : {};
				try {
					const prepared = await exec(container, modem, ["sh", "-c", "rm -rf /work/run && mkdir -p /work/run /work/.home && cp -a /opt/scaffold/. /work/run/"], { timeoutMs: 30_000, ...sig });
					if (prepared.code !== 0) throw new Error(`could not prepare the run: ${prepared.stderr.trim()}`);
					const copied = await exec(container, modem, ["sh", "-c", extractFresh("/work/run")], { stdin: tarFiles([{ path: "answer.txt", content: answer }]), timeoutMs: 30_000, ...sig });
					if (copied.code !== 0) throw new Error(`could not copy the answer: ${copied.stderr.trim()}`);
					const seconds = String(TEST_TIMEOUT_MS / 1000);
					const result = await exec(container, modem, ["timeout", "-k", "2", seconds, tests.program, ...tests.args], {
						stdin: Buffer.from(tests.code, "utf8"),
						workingDir: "/work/run",
						timeoutMs: TEST_TIMEOUT_MS + 15_000,
						...sig,
					});
					// The host-side backstop fired: the command may still be running inside.
					if (result.timedOut) await remove(key);
					return recipeResult(result, tests.program, image);
				} finally {
					if (lastUsed.has(name)) {
						lastUsed.set(name, { key, at: Date.now() });
						await exec(container, modem, ["rm", "-rf", "/work/run"], { timeoutMs: 30_000 }).catch(() => {});
					}
				}
			});
		},

		remove,

		async writeFiles({ key, image, dir, files, fresh }: { key: ItemKey; image: CodeImage; dir: string; files: TarEntry[]; fresh?: boolean }) {
			const container = await containerFor(key, image);
			const modem = docker().modem;
			if (fresh) {
				const prepared = await exec(container, modem, ["sh", "-c", `rm -rf ${dir} && mkdir -p ${dir} /work/.home && cp -a /opt/scaffold/. ${dir}/`], { timeoutMs: 30_000 });
				if (prepared.code !== 0) throw new Error(`could not prepare ${dir}: ${prepared.stderr.trim()}`);
			}
			const copied = await exec(container, modem, ["sh", "-c", extractFresh(dir)], { stdin: tarFiles(files), timeoutMs: 30_000 });
			if (copied.code !== 0) throw new Error(`could not copy the files: ${copied.stderr.trim()}`);
		},

		async spawn({ key, image, command, workingDir }: { key: ItemKey; image: CodeImage; command: string; workingDir: string }): Promise<SpawnedProcess> {
			const container = await containerFor(key, image);
			const created = await container.exec({ Cmd: ["sh", "-c", command], AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, WorkingDir: workingDir });
			const stream: Duplex = await created.start({ hijack: true, stdin: true });
			const stdout = new PassThrough();
			// stderr is the server's own log: drained, never shown.
			const stderr = new Writable({ write: (_c, _e, cb) => cb() });
			docker().modem.demuxStream(stream, stdout, stderr);
			const exited = new Promise<void>((resolve) => {
				const done = () => { stdout.end(); resolve(); };
				stream.on("end", done);
				stream.on("close", done);
				stream.on("error", done);
			});
			const stdin = new Writable({
				write(chunk, _encoding, callback) { stream.write(chunk, callback); },
				final(callback) { stream.end(); callback(); },
			});
			return { stdin, stdout, exited, kill: () => stream.destroy() };
		},

		/** Remove every workspace container (activation and deactivation). */
		async reapAll() {
			const containers = await docker().listContainers({ all: true, filters: { label: [`${WORKSPACE_LABEL}=${LABEL_VALUE}`] } }).catch(() => []);
			await Promise.all(containers.map((c) => docker().getContainer(c.Id).remove({ force: true }).catch(() => {})));
			lastUsed.clear();
		},

		/** The coding images on this machine (Settings → Coding). */
		async images(): Promise<ImageInfo[]> {
			const list = await docker().listImages({ filters: { label: [`${WORKSPACE_LABEL}=${LABEL_VALUE}`] } });
			const out: ImageInfo[] = [];
			for (const i of list) {
				for (const tag of i.RepoTags ?? []) {
					const m = /^learnharness-code-([a-z]+):/.exec(tag);
					if (!m || !(CODE_IMAGES as readonly string[]).includes(m[1]!)) continue;
					const image = m[1] as CodeImage;
					out.push({ image, tag, sizeBytes: i.Size, current: tag === tagOf(image) });
				}
			}
			return out.sort((a, b) => a.image.localeCompare(b.image));
		},

		/** Remove coding images (all, or one image's tags). In-use images are kept. */
		async removeImages(only?: CodeImage): Promise<number> {
			let removed = 0;
			for (const i of await runner.images()) {
				if (only && i.image !== only) continue;
				try { await docker().getImage(i.tag).remove(); removed++; } catch { /* in use: kept */ }
			}
			return removed;
		},

		dispose() { if (sweeper) clearInterval(sweeper); },
	};
	return runner;
}
