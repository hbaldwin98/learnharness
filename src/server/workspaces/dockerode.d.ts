/**
 * NARROW TYPES FOR dockerode 5.0.1 (owner ruling, plan step 2b): the
 * package ships no types, and @types/dockerode describes 4.x. These
 * declare only the calls src/server/workspaces/docker-runner.ts makes —
 * extend them when the runner uses more, never broaden speculatively.
 */
declare module "dockerode" {
	import type { Duplex, Readable, Writable } from "node:stream";

	namespace Docker {
		interface DockerOptions {
			socketPath?: string;
			host?: string;
			port?: number | string;
			protocol?: "http" | "https" | "ssh";
			username?: string;
			ca?: string | Buffer;
			cert?: string | Buffer;
			key?: string | Buffer;
			timeout?: number;
		}

		interface ImageInspectInfo {
			Id: string;
		}

		interface ImageInfo {
			Id: string;
			RepoTags: string[] | null;
		}

		interface ContainerInfo {
			Id: string;
			Names: string[];
			Labels: Record<string, string>;
		}

		interface ContainerInspectInfo {
			State: { Running: boolean };
		}

		interface ExecInspectInfo {
			Running: boolean;
			ExitCode: number | null;
		}

		interface HostConfig {
			AutoRemove?: boolean;
			NetworkMode?: string;
			ReadonlyRootfs?: boolean;
			Tmpfs?: Record<string, string>;
			Memory?: number;
			MemorySwap?: number;
			NanoCpus?: number;
			PidsLimit?: number;
			SecurityOpt?: string[];
			CapDrop?: string[];
		}

		interface ContainerCreateOptions {
			name?: string;
			Image: string;
			Cmd?: string[];
			User?: string;
			Labels?: Record<string, string>;
			HostConfig?: HostConfig;
		}

		interface ExecCreateOptions {
			Cmd: string[];
			AttachStdin?: boolean;
			AttachStdout?: boolean;
			AttachStderr?: boolean;
			WorkingDir?: string;
			Tty?: boolean;
		}

		interface ExecStartOptions {
			hijack?: boolean;
			stdin?: boolean;
			abortSignal?: AbortSignal;
		}

		interface Exec {
			start(options: ExecStartOptions): Promise<Duplex>;
			inspect(): Promise<ExecInspectInfo>;
		}

		interface Container {
			start(): Promise<unknown>;
			inspect(): Promise<ContainerInspectInfo>;
			remove(options?: { force?: boolean }): Promise<unknown>;
			exec(options: ExecCreateOptions): Promise<Exec>;
		}

		interface Image {
			inspect(): Promise<ImageInspectInfo>;
			remove(options?: { force?: boolean }): Promise<unknown>;
		}

		interface BuildImageOptions {
			t: string;
			labels?: Record<string, string>;
			rm?: boolean;
			forcerm?: boolean;
			abortSignal?: AbortSignal;
		}

		/** One JSON progress event of a (classic) build stream. */
		interface BuildEvent {
			stream?: string;
			status?: string;
			error?: string;
			errorDetail?: { message?: string };
		}

		interface Modem {
			followProgress(
				stream: Readable,
				onFinished: (error: Error | null, output: BuildEvent[]) => void,
				onProgress?: (event: BuildEvent) => void,
			): void;
			demuxStream(stream: Readable, stdout: Writable, stderr: Writable): void;
		}
	}

	class Docker {
		constructor(options?: Docker.DockerOptions);
		modem: Docker.Modem;
		ping(): Promise<unknown>;
		getImage(name: string): Docker.Image;
		listImages(options?: { filters?: string | Record<string, string[]> }): Promise<Docker.ImageInfo[]>;
		buildImage(context: Readable, options: Docker.BuildImageOptions): Promise<Readable>;
		getContainer(id: string): Docker.Container;
		createContainer(options: Docker.ContainerCreateOptions): Promise<Docker.Container>;
		listContainers(options?: { all?: boolean; filters?: string | Record<string, string[]> }): Promise<Docker.ContainerInfo[]>;
	}

	export = Docker;
}
