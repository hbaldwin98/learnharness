/**
 * PROJECT CONTAINERS: one long-lived container per project workspace.
 *
 * The project's host folder is bind-mounted at /work; a per-project named volume
 * holds HOME (/home/lh: package caches, tool config) so installs survive restarts.
 * Unlike the per-item sandbox, the container has network (installs), but keeps
 * uid 1000 (or the host uid on Linux), a read-only root, no-new-privileges and the
 * same memory/CPU/pid caps. Containers are recreated on demand and removed after
 * 30 minutes idle; files live in the folder and the volume, never the container.
 */

import type Docker from "dockerode";
import { WORKSPACE_LABEL, exec, extractFresh, type DockerRunner, type ExecResult } from "./docker-runner.ts";
import { tarFiles, type TarEntry } from "./tar.ts";
import type { CodeImage } from "./languages.ts";

const LABEL_VALUE = "project";
const PROJECT_LABEL = "learnharness.project";
const IDLE_MS = 30 * 60_000;
const GIB = 1024 * 1024 * 1024;
export const PROJECT_HOME = "/home/lh";
export const RUN_TIMEOUT_MS = 5 * 60_000;
export const RUN_CAP_BYTES = 256 * 1024;

export interface ProjectRef {
	id: string;
	image: CodeImage;
	hostPath: string;
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 60);
export const projectContainerName = (id: string) => `lh-proj-${safe(id)}`;
export const projectVolumeName = (id: string) => `lh-proj-${safe(id)}-home`;
const statusCode = (error: unknown) => (error as { statusCode?: number } | null)?.statusCode;

/** The uid:gid the learner's processes run as: the host user on Linux (bind-mount ownership), else 1000. */
export function containerUser(platform = process.platform, ids = { uid: process.getuid?.(), gid: process.getgid?.() }): string {
	return platform === "linux" && ids.uid !== undefined && ids.gid !== undefined ? `${ids.uid}:${ids.gid}` : "1000:1000";
}

/** The container create options (pure, for tests). */
export function projectContainerSpec(project: ProjectRef, tag: string, user = containerUser()): Docker.ContainerCreateOptions {
	return {
		name: projectContainerName(project.id),
		Image: tag,
		Cmd: ["sleep", "infinity"],
		User: user,
		WorkingDir: "/work",
		Env: [`HOME=${PROJECT_HOME}`],
		Labels: { [WORKSPACE_LABEL]: LABEL_VALUE, [PROJECT_LABEL]: project.id },
		HostConfig: {
			AutoRemove: true,
			Mounts: [
				{ Type: "bind", Source: project.hostPath, Target: "/work" },
				{ Type: "volume", Source: projectVolumeName(project.id), Target: PROJECT_HOME },
			],
			ReadonlyRootfs: true,
			Tmpfs: { "/tmp": "rw,exec,nosuid,size=512m,mode=1777" },
			Memory: 2 * GIB,
			MemorySwap: 2 * GIB,
			NanoCpus: 2_000_000_000,
			PidsLimit: 512,
			SecurityOpt: ["no-new-privileges"],
		},
	};
}

export type ProjectContainers = ReturnType<typeof createProjectContainers>;

export function createProjectContainers(runner: DockerRunner, options: { sweep?: boolean; onIdleRemoved?: (id: string) => void } = {}) {
	const docker = () => runner.engine();
	const lastUsed = new Map<string, number>();
	const starting = new Map<string, Promise<Docker.Container>>();

	async function start(project: ProjectRef, onProgress?: (line: string) => void): Promise<Docker.Container> {
		const name = projectContainerName(project.id);
		const existing = docker().getContainer(name);
		try {
			const info = await existing.inspect();
			const tag = runner.tagOf(project.image);
			if (info.State.Running && info.Config.Image === tag) return existing;
			await existing.remove({ force: true }).catch(() => {});
		} catch (error) {
			if (statusCode(error) !== 404) throw error;
		}
		const built = await runner.ensureImage(project.image, onProgress);
		if (!built.ok) throw new Error(`the ${project.image} image failed to build`);
		const user = containerUser();
		const container = await docker().createContainer(projectContainerSpec(project, runner.tagOf(project.image), user));
		await container.start();
		// A fresh named volume is root-owned: hand HOME to the learner's user.
		await exec(container, docker().modem, ["chown", user, PROJECT_HOME], { timeoutMs: 30_000, user: "0" }).catch(() => {});
		return container;
	}

	/** The running container for a project (created when missing or on an outdated image). */
	function ensure(project: ProjectRef, onProgress?: (line: string) => void): Promise<Docker.Container> {
		lastUsed.set(project.id, Date.now());
		const inFlight = starting.get(project.id);
		if (inFlight) return inFlight;
		const next = start(project, onProgress).finally(() => starting.delete(project.id));
		starting.set(project.id, next);
		return next;
	}

	async function remove(id: string): Promise<void> {
		lastUsed.delete(id);
		await docker().getContainer(projectContainerName(id)).remove({ force: true }).catch(() => {});
	}

	const sweeper = options.sweep === false ? null : setInterval(() => {
		const now = Date.now();
		for (const [id, at] of lastUsed) {
			if (now - at <= IDLE_MS) continue;
			options.onIdleRemoved?.(id);
			void remove(id);
		}
	}, 5 * 60_000);
	sweeper?.unref();

	return {
		ensure,
		remove,
		async running(id: string): Promise<boolean> {
			try { return (await docker().getContainer(projectContainerName(id)).inspect()).State.Running; } catch { return false; }
		},
		/** Run a shell command in /work (login shell, bounded time and output). */
		async run(project: ProjectRef, command: string, opts: { signal?: AbortSignal; onProgress?: (line: string) => void; timeoutMs?: number } = {}): Promise<ExecResult> {
			const container = await ensure(project, opts.onProgress);
			try {
				return await exec(container, docker().modem, ["sh", "-lc", command], {
					workingDir: "/work",
					timeoutMs: opts.timeoutMs ?? RUN_TIMEOUT_MS,
					cap: RUN_CAP_BYTES,
					...(opts.signal ? { signal: opts.signal } : {}),
				});
			} finally {
				lastUsed.set(project.id, Date.now());
			}
		},
		/**
		 * Run a task's tests against the project: hidden test files go to a fresh
		 * /tmp/lh-task (never the learner's folder, exposed as $LH_TESTS), then the
		 * command runs in /work. The test files are removed afterwards.
		 */
		async runTask(project: ProjectRef, input: { command: string; files: TarEntry[]; signal?: AbortSignal; timeoutMs?: number }): Promise<ExecResult> {
			const container = await ensure(project);
			const modem = docker().modem;
			const dir = "/tmp/lh-task";
			try {
				const prepared = await exec(container, modem, ["sh", "-c", `rm -rf ${dir} && mkdir -p ${dir}`], { timeoutMs: 30_000 });
				if (prepared.code !== 0) throw new Error(`could not prepare the tests: ${prepared.stderr.trim()}`);
				if (input.files.length) {
					const copied = await exec(container, modem, ["sh", "-c", extractFresh(dir)], { stdin: tarFiles(input.files), timeoutMs: 30_000 });
					if (copied.code !== 0) throw new Error(`could not copy the tests: ${copied.stderr.trim()}`);
				}
				return await exec(container, modem, ["sh", "-lc", `export LH_TESTS=${dir}; ${input.command}`], {
					workingDir: "/work",
					timeoutMs: input.timeoutMs ?? RUN_TIMEOUT_MS,
					cap: RUN_CAP_BYTES,
					...(input.signal ? { signal: input.signal } : {}),
				});
			} finally {
				lastUsed.set(project.id, Date.now());
				await exec(container, modem, ["rm", "-rf", dir], { timeoutMs: 30_000 }).catch(() => {});
			}
		},
		/** Remove the project's container and its HOME volume (project removal). */
		async destroy(id: string): Promise<void> {
			await remove(id);
			await docker().getVolume(projectVolumeName(id)).remove().catch(() => {});
		},
		/** Remove every project container (activation and deactivation); volumes are kept. */
		async reapAll(): Promise<void> {
			const containers = await docker().listContainers({ all: true, filters: { label: [`${WORKSPACE_LABEL}=${LABEL_VALUE}`] } }).catch(() => []);
			await Promise.all(containers.map(c => docker().getContainer(c.Id).remove({ force: true }).catch(() => {})));
			lastUsed.clear();
		},
		dispose() { if (sweeper) clearInterval(sweeper); },
	};
}
