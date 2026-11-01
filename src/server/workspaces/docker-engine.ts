/**
 * FINDING THE DOCKER ENGINE WITHOUT THE CLI (owner ruling, plan step 2b):
 *   1. DOCKER_HOST (with DOCKER_TLS_VERIFY / DOCKER_CERT_PATH);
 *   2. otherwise the current context — DOCKER_CONTEXT, or currentContext
 *      in ~/.docker/config.json — whose endpoint lives in
 *      ~/.docker/contexts/meta/<sha256(name)>/meta.json (TLS material in
 *      ~/.docker/contexts/tls/<sha256(name)>/docker/);
 *   3. otherwise the platform default socket / named pipe.
 * Also "is Docker installed?" — a filesystem check only (the binary on
 * PATH or in Docker Desktop's install dir, or an explicit host/context):
 * no process is started.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Docker from "dockerode";

export interface EngineEnvironment {
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
	homeDir: string;
	exists: (p: string) => boolean;
	read: (p: string) => string | null;
}

export const realEnvironment = (): EngineEnvironment => ({
	env: process.env,
	platform: process.platform,
	homeDir: os.homedir(),
	exists: (p) => fs.existsSync(p),
	read: (p) => {
		try {
			return fs.readFileSync(p, "utf8");
		} catch {
			return null;
		}
	},
});

export interface EngineEndpoint {
	/** Where the endpoint came from (diagnostics). */
	source: "DOCKER_HOST" | `context ${string}` | "default";
	options: Docker.DockerOptions;
}

/** The target platform's path rules (not the host's — tests run any platform anywhere). */
const pathFor = (e: EngineEnvironment) => (e.platform === "win32" ? path.win32 : path.posix);

function dockerConfigDir(e: EngineEnvironment): string {
	return e.env.DOCKER_CONFIG ?? pathFor(e).join(e.homeDir, ".docker");
}

/** The current context's name, or null for the default context. */
function currentContext(e: EngineEnvironment): string | null {
	const fromEnv = e.env.DOCKER_CONTEXT?.trim();
	let name = fromEnv || null;
	if (!name) {
		const raw = e.read(pathFor(e).join(dockerConfigDir(e), "config.json"));
		if (raw) {
			try {
				const parsed = JSON.parse(raw) as { currentContext?: unknown };
				if (typeof parsed.currentContext === "string") name = parsed.currentContext.trim() || null;
			} catch {
				// unreadable config: fall through to the default
			}
		}
	}
	return name && name !== "default" ? name : null;
}

/** Parse a Docker host URL into dockerode options; null if unsupported. */
export function parseDockerHost(
	host: string,
	tls?: { ca: string | null; cert: string | null; key: string | null } | null,
): Docker.DockerOptions | null {
	if (host.startsWith("unix://")) return { socketPath: host.slice("unix://".length) };
	if (host.startsWith("npipe://")) return { socketPath: host.slice("npipe:".length).replace(/^\/\/\/\//, "//") };
	let url: URL;
	try {
		url = new URL(host);
	} catch {
		return null;
	}
	if (url.protocol === "tcp:" || url.protocol === "http:" || url.protocol === "https:") {
		const secure = url.protocol === "https:" || Boolean(tls && (tls.ca || tls.cert));
		return {
			host: url.hostname,
			port: url.port || (secure ? "2376" : "2375"),
			protocol: secure ? "https" : "http",
			...(tls?.ca ? { ca: tls.ca } : {}),
			...(tls?.cert ? { cert: tls.cert } : {}),
			...(tls?.key ? { key: tls.key } : {}),
		};
	}
	if (url.protocol === "ssh:") {
		return { protocol: "ssh", host: url.hostname, port: url.port || "22", ...(url.username ? { username: decodeURIComponent(url.username) } : {}) };
	}
	return null;
}

const readTls = (e: EngineEnvironment, dir: string) => ({
	ca: e.read(pathFor(e).join(dir, "ca.pem")),
	cert: e.read(pathFor(e).join(dir, "cert.pem")),
	key: e.read(pathFor(e).join(dir, "key.pem")),
});

/** Resolve the engine endpoint (never throws). */
export function resolveEngine(e: EngineEnvironment = realEnvironment()): EngineEndpoint {
	const dockerHost = e.env.DOCKER_HOST?.trim();
	if (dockerHost) {
		const verify = e.env.DOCKER_TLS_VERIFY && e.env.DOCKER_TLS_VERIFY !== "0";
		const certDir = e.env.DOCKER_CERT_PATH ?? dockerConfigDir(e);
		const options = parseDockerHost(dockerHost, verify ? readTls(e, certDir) : null);
		if (options) return { source: "DOCKER_HOST", options };
	}
	const context = currentContext(e);
	if (context) {
		const hash = createHash("sha256").update(context).digest("hex");
		const raw = e.read(pathFor(e).join(dockerConfigDir(e), "contexts", "meta", hash, "meta.json"));
		if (raw) {
			try {
				const meta = JSON.parse(raw) as { Endpoints?: { docker?: { Host?: unknown; SkipTLSVerify?: unknown } } };
				const host = meta.Endpoints?.docker?.Host;
				if (typeof host === "string") {
					const tlsDir = pathFor(e).join(dockerConfigDir(e), "contexts", "tls", hash, "docker");
					const options = parseDockerHost(host, e.exists(tlsDir) ? readTls(e, tlsDir) : null);
					if (options) return { source: `context ${context}`, options };
				}
			} catch {
				// malformed metadata: fall through to the default
			}
		}
	}
	if (e.platform === "win32") return { source: "default", options: { socketPath: "//./pipe/docker_engine" } };
	const userSocket = path.posix.join(e.homeDir, ".docker", "run", "docker.sock");
	const socketPath = !e.exists("/var/run/docker.sock") && e.exists(userSocket) ? userSocket : "/var/run/docker.sock";
	return { source: "default", options: { socketPath } };
}

/** Where Docker Desktop installs its CLI when PATH doesn't carry it. */
function knownDockerPaths(e: EngineEnvironment): string[] {
	if (e.platform === "win32") {
		const programFiles = e.env.ProgramFiles ?? "C:\\Program Files";
		return [path.win32.join(programFiles, "Docker", "Docker", "resources", "bin", "docker.exe")];
	}
	return ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker", "/usr/bin/docker"];
}

/** Is Docker installed? The binary on disk, or an explicit host/context. */
export function dockerInstalled(e: EngineEnvironment = realEnvironment()): boolean {
	if (e.env.DOCKER_HOST?.trim() || currentContext(e)) return true;
	const paths = pathFor(e);
	const name = e.platform === "win32" ? "docker.exe" : "docker";
	const dirs = (e.env.PATH ?? e.env.Path ?? "").split(e.platform === "win32" ? ";" : ":").filter(Boolean);
	return dirs.some((d) => e.exists(paths.join(d, name))) || knownDockerPaths(e).some((p) => e.exists(p));
}
