/**
 * THE WORKSPACE SERVICE: one record per coding item (a coding-questions
 * question or practice problem) with the learner's live code, narration, Run
 * results, annotations and what the agent last saw. It owns the Run button's
 * sandboxed runs, the language server, the trace bundles (Ask, Submit,
 * listening) and the listening cue loop. Side effects are injected so the
 * service is testable without Docker or the host.
 */

import { randomUUID } from "node:crypto";
import { anchorOf, MAX_ANNOTATION_CHARS, MAX_ANNOTATIONS, reanchor } from "../shared/annotations.ts";
import { addCue, cueLabel, cueText, isStruggle, listenDecision, newListenState, timerCues, type ListenCue, type ListenState } from "../shared/listening.ts";
import type { CodeAnnotation, CodingSettings, CodingTestResult, CodingTests, DiagnosticsSnapshot, DockerStatus, NarrationLine, RunRecord, WorkspaceState } from "../shared/protocol.ts";
import { formatTrace, traceIsEmpty } from "../shared/trace.ts";
import type { DiagnosticsSession } from "./diagnostics.ts";
import { languageSpec, type CodeImage, type LanguageSpec } from "./languages.ts";
import type { ImageResult, ItemKey } from "./docker-runner.ts";

/** Kept per item (older entries drop off the pane; the agent saw them). */
const MAX_RUNS = 20;
const MAX_NARRATION = 500;
const MAX_NARRATION_CHARS = 2000;
const MAX_CODE_CHARS = 512 * 1024;

export interface WorkspaceRecord {
	chatId: string;
	itemId: string;
	kind: "question" | "problem";
	language: string;
	tests: CodingTests | null;
	code: string;
	/** Code the agent last saw (null: never). */
	seenCode: string | null;
	narration: NarrationLine[];
	runs: RunRecord[];
	/** Counts of narration/runs already delivered to the agent. */
	seenNarration: number;
	seenRuns: number;
	annotations: CodeAnnotation[];
	updatedAt: string;
}

export interface WorkspaceStore {
	load(key: ItemKey): WorkspaceRecord | null;
	save(record: WorkspaceRecord): void;
}

export interface SteerInput {
	displayText: string;
	modelText: string;
	details?: unknown;
	idempotencyKey: string;
	trigger: "learner" | "background";
}

export interface WorkspaceDeps {
	runner: {
		status(): Promise<DockerStatus>;
		ensureImage(image: CodeImage, onProgress?: (line: string) => void, signal?: AbortSignal): Promise<ImageResult>;
		runRecipe(input: { key: ItemKey; image: CodeImage; answer: string; tests: CodingTests; signal?: AbortSignal }): Promise<CodingTestResult>;
		remove(key: ItemKey): Promise<void>;
	};
	startDiagnostics(key: ItemKey, spec: LanguageSpec, code: string, onChange: () => void): DiagnosticsSession;
	store: WorkspaceStore;
	emitState(state: WorkspaceState): void;
	steer(chatId: string, input: SteerInput): Promise<{ delivery: string }>;
	appendMarker(chatId: string, input: { typeId: string; details: unknown; modelText?: string; idempotencyKey?: string }): Promise<unknown>;
	settings(): CodingSettings;
	now?: () => number;
	log?: (message: string, error?: unknown) => void;
}

interface Live {
	record: WorkspaceRecord;
	diagnostics: DiagnosticsSession | null;
	running: string | null;
	listen: ListenState;
	docker: DockerStatus;
	/** Editors currently mounted for this item (several windows may show it). */
	opened: number;
}

const keyString = (k: ItemKey) => `${k.chatId}\0${k.itemId}`;

export function createWorkspaces(deps: WorkspaceDeps) {
	const now = deps.now ?? Date.now;
	const iso = () => new Date(now()).toISOString();
	const log = deps.log ?? ((message: string, error?: unknown) => console.error(`[coding-workspaces] ${message}`, error ?? ""));
	const live = new Map<string, Live>();
	/** Per chat: the item an editor opened most recently (annotate's target). */
	const activeByChat = new Map<string, ItemKey>();
	/** Per chat: whether the last delivered steer was the learner's (stay_quiet refuses then). */
	const lastSteer = new Map<string, "learner" | "background">();
	const turnRunning = new Set<string>();
	const lastLookAt = new Map<string, number>();
	let sequence = 0;

	function state(item: Live): WorkspaceState {
		const r = item.record;
		const spec = languageSpec(r.language);
		const diagnostics: DiagnosticsSnapshot = item.diagnostics?.snapshot() ?? { status: "unavailable", name: spec?.lsp.name ?? "", diagnostics: [] };
		return {
			chatId: r.chatId, itemId: r.itemId, kind: r.kind, language: r.language, image: spec?.image ?? null,
			docker: item.docker, running: item.running, runs: r.runs, narration: r.narration, annotations: r.annotations,
			diagnostics, listening: deps.settings().listening,
		};
	}

	const publish = (item: Live) => deps.emitState(state(item));
	const save = (item: Live) => { item.record.updatedAt = iso(); deps.store.save(item.record); };
	const get = (key: ItemKey) => live.get(keyString(key));

	function require(key: ItemKey): Live {
		const item = get(key);
		if (!item) throw new Error("This coding workspace is not open");
		return item;
	}

	async function startDiagnostics(item: Live) {
		const spec = languageSpec(item.record.language);
		if (!spec || item.diagnostics || item.docker !== "running") return;
		const key = { chatId: item.record.chatId, itemId: item.record.itemId };
		const image = await deps.runner.ensureImage(spec.image, line => { item.running = line; publish(item); }).catch(error => ({ ok: false as const, output: String(error) }));
		item.running = null;
		if (!image.ok) { publish(item); return; }
		if (item.diagnostics || item.opened === 0) return;
		item.diagnostics = deps.startDiagnostics(key, spec, item.record.code, () => publish(item));
		publish(item);
	}

	/** The trace since the agent last looked; marks it seen. */
	function takeTrace(item: Live, headline: string): string {
		const r = item.record;
		const text = formatTrace(headline, {
			language: r.language,
			narration: r.narration.slice(r.seenNarration),
			runs: r.runs.slice(r.seenRuns),
			seenCode: r.seenCode,
			code: r.code,
			diagnostics: item.diagnostics?.snapshot().diagnostics ?? [],
		});
		return text;
	}

	function markSeen(item: Live) {
		const r = item.record;
		r.seenNarration = r.narration.length;
		r.seenRuns = r.runs.length;
		r.seenCode = r.code;
		item.listen.pending = [];
		save(item);
	}

	function activity(item: Live) {
		item.listen.lastActivityAt = now();
	}

	async function fireListening(item: Live, cues: ListenCue[]) {
		const r = item.record;
		item.listen.lastListenAt = now();
		item.listen.pending = [];
		const modelText = takeTrace(item, `Listening update (${cueText(cues)}). This is not a request: reply only if it helps right now; otherwise call stay_quiet.`);
		try {
			await deps.steer(r.chatId, {
				displayText: `Agent looked in · ${cueLabel(cues)}`,
				modelText,
				details: { kind: "listening", itemId: r.itemId, cues },
				idempotencyKey: `listen:${r.itemId}:${now()}:${++sequence}`,
				trigger: "background",
			});
			lastSteer.set(r.chatId, "background");
			markSeen(item);
		} catch (error) {
			log("listening update was not delivered", error);
		}
	}

	return {
		state: (key: ItemKey) => state(require(key)),
		activeItem: (chatId: string) => activeByChat.get(chatId) ?? null,

		async open(input: { chatId: string; itemId: string; kind: "question" | "problem"; language: string; tests: CodingTests | null; code: string }): Promise<WorkspaceState> {
			const key = { chatId: input.chatId, itemId: input.itemId };
			let item = get(key);
			if (!item) {
				const stored = deps.store.load(key);
				const record: WorkspaceRecord = stored ?? {
					...key, kind: input.kind, language: input.language, tests: input.tests, code: input.code, seenCode: null,
					narration: [], runs: [], seenNarration: 0, seenRuns: 0, annotations: [], updatedAt: iso(),
				};
				record.tests = input.tests ?? record.tests;
				record.language = input.language;
				item = { record, diagnostics: null, running: null, listen: newListenState(now()), docker: "missing", opened: 0 };
				live.set(keyString(key), item);
			}
			item.opened++;
			activeByChat.set(input.chatId, key);
			if (input.code !== item.record.code) this.code(key, input.code);
			item.docker = await deps.runner.status();
			void startDiagnostics(item);
			save(item);
			return state(item);
		},

		code(key: ItemKey, code: string) {
			const item = require(key);
			if (code.length > MAX_CODE_CHARS) throw new Error("The code is too large");
			if (code === item.record.code) return;
			item.record.code = code;
			item.record.annotations = item.record.annotations.map(a => reanchor(a, code));
			item.diagnostics?.update(code);
			activity(item);
			save(item);
			publish(item);
		},

		async close(key: ItemKey) {
			const item = get(key);
			if (!item) return;
			item.opened = Math.max(0, item.opened - 1);
			if (item.opened > 0) return;
			const session = item.diagnostics;
			item.diagnostics = null;
			live.delete(keyString(key));
			await session?.stop().catch(() => {});
		},

		presence(key: ItemKey) {
			const item = get(key);
			if (item) item.listen.presentAt = now();
		},

		async run(key: ItemKey, code: string, signal?: AbortSignal): Promise<RunRecord> {
			const item = require(key);
			const r = item.record;
			if (item.running) throw new Error("A run is already in progress");
			if (!r.tests) throw new Error("This item has no tests to run");
			this.code(key, code);
			const spec = languageSpec(r.language);
			item.running = "Starting…";
			publish(item);
			let result: CodingTestResult;
			try {
				item.docker = await deps.runner.status();
				if (!spec) throw new Error(`There is no sandbox for ${r.language}; Run needs one`);
				if (item.docker !== "running") throw new Error(item.docker === "missing" ? "Docker is not installed" : "Docker is not running — start it to Run");
				const image = await deps.runner.ensureImage(spec.image, line => { item.running = line; publish(item); }, signal);
				if (!image.ok) throw new Error(`The ${spec.image} sandbox failed to build:\n${image.output}`);
				item.running = "Running the tests…";
				publish(item);
				result = await deps.runner.runRecipe({ key, image: spec.image, answer: r.code, tests: r.tests, ...(signal ? { signal } : {}) });
				void startDiagnostics(item);
			} catch (error) {
				if (signal?.aborted) { item.running = null; publish(item); throw error; }
				result = { status: "error", exitCode: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, message: error instanceof Error ? error.message : String(error) };
			} finally {
				item.running = null;
			}
			const record: RunRecord = { at: iso(), result };
			r.runs.push(record);
			if (r.runs.length > MAX_RUNS) {
				const drop = r.runs.length - MAX_RUNS;
				r.runs.splice(0, drop);
				r.seenRuns = Math.max(0, r.seenRuns - drop);
			}
			activity(item);
			addCue(item.listen, "run");
			save(item);
			publish(item);
			return record;
		},

		narrate(key: ItemKey, text: string) {
			const item = require(key);
			const line = text.trim().slice(0, MAX_NARRATION_CHARS);
			if (!line) return;
			const r = item.record;
			r.narration.push({ at: iso(), text: line });
			if (r.narration.length > MAX_NARRATION) {
				const drop = r.narration.length - MAX_NARRATION;
				r.narration.splice(0, drop);
				r.seenNarration = Math.max(0, r.seenNarration - drop);
			}
			activity(item);
			if (isStruggle(line)) addCue(item.listen, "struggle");
			save(item);
			publish(item);
		},

		/** The learner's Ask: the strip's draft plus the trace, as a learner steer. */
		async ask(key: ItemKey, text: string, code: string): Promise<{ delivery: string }> {
			const item = require(key);
			this.code(key, code);
			if (text.trim()) this.narrate(key, text);
			const question = text.trim();
			const modelText = takeTrace(item, question
				? `The learner asks for help with their coding work: "${question}". Answer at the smallest useful size; point at lines with annotate rather than rewriting their code.`
				: "The learner asks for help with their coding work (no words — look at where they are). Answer at the smallest useful size; point at lines with annotate rather than rewriting their code.");
			const receipt = await deps.steer(key.chatId, {
				displayText: question ? `Ask: ${question}` : "Asked for help",
				modelText,
				details: { kind: "ask", itemId: key.itemId, text: question },
				idempotencyKey: `ask:${key.itemId}:${now()}:${++sequence}`,
				trigger: "learner",
			});
			lastSteer.set(key.chatId, "learner");
			markSeen(item);
			return receipt;
		},

		/** coding-questions graded a submission: give the agent the trace beside it. */
		async submitted(key: ItemKey, answer: string) {
			const item = get(key);
			if (!item) return;
			item.record.code = answer;
			const trace = { language: item.record.language, narration: item.record.narration.slice(item.record.seenNarration), runs: item.record.runs.slice(item.record.seenRuns), seenCode: item.record.seenCode, code: answer, diagnostics: item.diagnostics?.snapshot().diagnostics ?? [] };
			if (traceIsEmpty({ ...trace, seenCode: answer })) { markSeen(item); return; }
			// The submission itself carries the code; send only what it lacks.
			const modelText = formatTrace("Workspace trace for the learner's submission (narration, Runs and editor problems since you last looked).", { ...trace, seenCode: answer });
			await deps.appendMarker(key.chatId, { typeId: "trace", details: { itemId: key.itemId, kind: "submission" }, modelText, idempotencyKey: `submit:${key.itemId}:${now()}:${++sequence}` });
			lastSteer.set(key.chatId, "learner");
			markSeen(item);
		},

		/** The annotate tool: pin a note to lines of the active item's current code. */
		annotate(chatId: string, input: { line: number; endLine?: number; note: string }): { ok: true; text: string; annotation: CodeAnnotation; itemId: string } | { ok: false; errors: string[] } {
			const key = activeByChat.get(chatId);
			const item = key ? get(key) : undefined;
			if (!key || !item) return { ok: false, errors: ["no coding question or problem is open in the learner's editor"] };
			const lines = item.record.code.split("\n").length;
			const endLine = input.endLine ?? input.line;
			const errors: string[] = [];
			if (!Number.isInteger(input.line) || input.line < 1 || input.line > lines) errors.push(`line must be between 1 and ${lines}`);
			if (!Number.isInteger(endLine) || endLine < input.line || endLine > lines) errors.push(`endLine must be between line and ${lines}`);
			const note = input.note.trim();
			if (!note) errors.push("note must be non-empty");
			if (note.length > MAX_ANNOTATION_CHARS) errors.push(`note must be at most ${MAX_ANNOTATION_CHARS} characters`);
			if (item.record.annotations.filter(a => !a.outdated).length >= MAX_ANNOTATIONS) errors.push(`at most ${MAX_ANNOTATIONS} live annotations`);
			if (errors.length) return { ok: false, errors };
			const annotation: CodeAnnotation = { id: randomUUID(), line: input.line, endLine, note, at: iso(), anchor: anchorOf(item.record.code, input.line, endLine) };
			item.record.annotations.push(annotation);
			save(item);
			publish(item);
			return { ok: true, annotation, itemId: key.itemId, text: `Annotated line${endLine > input.line ? `s ${input.line}–${endLine}` : ` ${input.line}`}. The learner sees the note beside their code.` };
		},

		/** stay_quiet is accepted only after a listening update, never after the learner's own request. */
		quietAllowed: (chatId: string) => lastSteer.get(chatId) === "background",

		turnStarted(chatId: string) { turnRunning.add(chatId); },
		turnSettled(chatId: string) {
			turnRunning.delete(chatId);
			lastLookAt.set(chatId, now());
		},

		/** One listening tick: timer cues, then fire where the gates allow. */
		async tick() {
			const settings = deps.settings();
			for (const item of live.values()) {
				const chatId = item.record.chatId;
				timerCues(item.listen, now(), lastLookAt.get(chatId) ?? item.listen.lastActivityAt);
				const decision = listenDecision(item.listen, now(), { enabled: settings.listening, backgroundAllowed: true, turnRunning: turnRunning.has(chatId), recordBlocked: false });
				if (decision.fire) await fireListening(item, decision.cues);
			}
		},

		async dispose() {
			const sessions = [...live.values()].map(item => item.diagnostics).filter(Boolean) as DiagnosticsSession[];
			live.clear();
			await Promise.all(sessions.map(s => s.stop().catch(() => {})));
		},

		publishAll() { for (const item of live.values()) publish(item); },
	};
}

export type Workspaces = ReturnType<typeof createWorkspaces>;
