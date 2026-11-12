/** Browser-safe shapes shared by the coding-workspaces backend and frontend. */

export const PLUGIN_ID = "coding-workspaces";

export type DockerStatus = "missing" | "stopped" | "running";

/** Zero-based (LSP) ranges in the learner's single answer file. */
export interface CodeDiagnostic {
	path: string;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	severity: "error" | "warning";
	message: string;
	source?: string;
}

export type DiagnosticsStatus = "starting" | "ready" | "crashed" | "unavailable";

export interface DiagnosticsSnapshot {
	status: DiagnosticsStatus;
	/** "Python", "C#", … for the status line; "" when no server exists. */
	name: string;
	diagnostics: CodeDiagnostic[];
}

/** The teacher's test recipe (coding-questions' `tests`). */
export interface CodingTests {
	program: string;
	args: string[];
	code: string;
}

/** coding-questions' CodingTestResult (structural copy) plus the plugin's notice. */
export interface CodingTestResult {
	status: "passed" | "failed" | "error";
	exitCode: number | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	message?: string;
	notice?: string;
}

export interface RunRecord {
	at: string;
	result: CodingTestResult;
}

export interface NarrationLine {
	at: string;
	text: string;
}

/** A note the agent pinned to lines of the learner's code (1-based, inclusive). */
export interface CodeAnnotation {
	id: string;
	line: number;
	endLine: number;
	note: string;
	at: string;
	anchor: string[];
	outdated?: boolean;
}

export interface WorkspaceState {
	chatId: string;
	itemId: string;
	kind: "question" | "problem";
	language: string;
	/** Docker image serving this language, or null when unsupported. */
	image: string | null;
	docker: DockerStatus;
	/** A Run is in progress (with its progress line). */
	running: string | null;
	runs: RunRecord[];
	narration: NarrationLine[];
	annotations: CodeAnnotation[];
	diagnostics: DiagnosticsSnapshot;
	listening: boolean;
}

export interface CodingSettings {
	/** Agent listening (automatic looks while the learner works). */
	listening: boolean;
}

export const DEFAULT_SETTINGS: CodingSettings = { listening: true };

export interface ImageInfo {
	image: string;
	tag: string;
	sizeBytes: number;
	current: boolean;
}

/** Frontend → backend operations. */
export const OPS = {
	open: "workspace.open",
	code: "workspace.code",
	close: "workspace.close",
	get: "workspace.get",
	run: "workspace.run",
	narrate: "workspace.narrate",
	ask: "workspace.ask",
	presence: "workspace.presence",
	settingsGet: "settings.get",
	settingsSet: "settings.set",
	dockerStatus: "docker.status",
	images: "docker.images",
	removeImages: "docker.remove-images",
} as const;

/** Backend → frontend notification topics. */
export const TOPICS = { state: "state", settings: "settings" } as const;

/** Marker type ids. */
export const MARKERS = { trace: "trace", annotation: "annotation", quiet: "quiet" } as const;
