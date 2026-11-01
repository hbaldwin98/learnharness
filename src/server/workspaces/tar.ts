/**
 * A minimal ustar writer: the coding runner pipes files into a container
 * as a tar stream (`docker exec -i … tar -x`), so no host directory is
 * ever mounted. Regular files plus their parent directories only; paths
 * are pre-validated (relative, ≤ 100 characters).
 */

export interface TarEntry {
	path: string;
	/** Text (UTF-8) or raw bytes (image build contexts). */
	content: string | Buffer;
}

const BLOCK = 512;

function header(name: string, size: number, type: "0" | "5", mode: number): Buffer {
	const h = Buffer.alloc(BLOCK, 0);
	const write = (value: string, offset: number, length: number) => h.write(value, offset, length, "utf8");
	const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, "0") + "\0";
	if (Buffer.byteLength(name) > 100) throw new Error(`tar path too long: ${name}`);
	write(name, 0, 100);
	write(octal(mode, 8), 100, 8);
	write(octal(0, 8), 108, 8); // uid
	write(octal(0, 8), 116, 8); // gid
	write(octal(size, 12), 124, 12);
	write(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
	write("        ", 148, 8); // checksum placeholder (spaces)
	write(type, 156, 1);
	write("ustar\0", 257, 6);
	write("00", 263, 2);
	let sum = 0;
	for (const byte of h) sum += byte;
	write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
	return h;
}

/** Encode entries (and their parent directories) as one tar archive. */
export function tarFiles(entries: readonly TarEntry[]): Buffer {
	const parts: Buffer[] = [];
	const dirs = new Set<string>();
	for (const entry of entries) {
		const segments = entry.path.split("/");
		for (let i = 1; i < segments.length; i++) {
			const dir = segments.slice(0, i).join("/") + "/";
			if (dirs.has(dir)) continue;
			dirs.add(dir);
			parts.push(header(dir, 0, "5", 0o755));
		}
		const body = typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : entry.content;
		parts.push(header(entry.path, body.length, "0", 0o644), body);
		const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
		if (pad > 0) parts.push(Buffer.alloc(pad, 0));
	}
	parts.push(Buffer.alloc(BLOCK * 2, 0));
	return Buffer.concat(parts);
}
