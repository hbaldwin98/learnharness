import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { PluginBackendContext, PluginTools } from "learnharness-plugin-api";
import { codingRunnerRegistry, type CodingRunner } from "../../coding-questions/src/runner-hook.ts";
import { DEFAULT_SETTINGS, OPS, TOPICS, type CodingSettings, type CodingTests } from "./shared/protocol.ts";
import { createDiagnosticsSession } from "./server/diagnostics.ts";
import { createDockerRunner, type ItemKey } from "./server/docker-runner.ts";
import { CODE_IMAGES, languageSpec, SANDBOX_TOOLS, type CodeImage } from "./server/languages.ts";
import { createFileStore } from "./server/store.ts";
import { createWorkspaces } from "./server/workspaces.ts";
import { registerProjectOps } from "./server/project-ops.ts";
import { ANNOTATE_DESCRIPTION, instructions, STAY_QUIET_DESCRIPTION } from "./server/prompts.ts";

type Tool = ReturnType<PluginTools["create"]>[number];
const TICK_MS = 10_000;

const str = (value: unknown, name: string): string => {
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	return value;
};
const obj = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Input must be an object");
	return value as Record<string, unknown>;
};
const keyOf = (input: Record<string, unknown>): ItemKey => ({ chatId: str(input.chatId, "chatId"), itemId: str(input.itemId, "itemId") });

export function readTests(value: unknown): CodingTests | null {
	if (!value || typeof value !== "object") return null;
	const t = value as Record<string, unknown>;
	if (typeof t.program !== "string" || !Array.isArray(t.args) || t.args.some(a => typeof a !== "string") || typeof t.code !== "string") return null;
	return { program: t.program, args: t.args as string[], code: t.code };
}

export function readSettings(file: string): CodingSettings {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CodingSettings>;
		return { listening: typeof raw.listening === "boolean" ? raw.listening : DEFAULT_SETTINGS.listening };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function activate(ctx: PluginBackendContext): () => Promise<void> {
	fs.mkdirSync(ctx.dataDirectory, { recursive: true });
	const settingsFile = path.join(ctx.dataDirectory, "settings.json");
	let settings = readSettings(settingsFile);
	const runner = createDockerRunner({
		imageRoot: path.join(ctx.directory, "docker"),
		onIdleRemoved: key => { void workspaces.containerRemoved(key); },
	});
	const workspaces = createWorkspaces({
		runner,
		startDiagnostics: (key, spec, code, onChange) => createDiagnosticsSession({ runner, key, spec, code, onChange }),
		store: createFileStore(path.join(ctx.dataDirectory, "workspaces")),
		emitState: state => { if (!ctx.signal.aborted) ctx.events.emit(TOPICS.state, state); },
		steer: (chatId, input) => ctx.turns.steer(chatId, input),
		appendMarker: (chatId, input) => ctx.markers.append(chatId, input),
		settings: () => settings,
	});
	const cleanups: Array<() => unknown> = [];

	// Orphaned containers from an earlier run (best effort, only when Docker is up).
	void runner.status().then(status => status === "running" ? runner.reapAll() : undefined).catch(() => {});

	// ── coding-questions runner hook: Submit and grading in the sandbox ──────────
	const sandbox: CodingRunner = {
		id: "coding-workspaces",
		async run(request) {
			const spec = languageSpec(request.language);
			if (!spec) return { unavailable: `there is no sandbox for ${request.language || "this language"}` };
			const status = await runner.status();
			if (status !== "running") return { unavailable: status === "missing" ? "Docker is not installed" : "Docker is not running" };
			try {
				const image = await runner.ensureImage(spec.image, undefined, request.signal);
				if (!image.ok) return { unavailable: `the ${spec.image} sandbox failed to build` };
				const key = { chatId: request.chatId, itemId: request.itemId };
				const result = await runner.runRecipe({ key, image: spec.image, answer: request.answer, tests: request.tests, ...(request.signal ? { signal: request.signal } : {}) });
				if (request.purpose !== "run") await workspaces.submitted(key, request.answer).catch(error => console.error("[coding-workspaces] trace for submission failed", error));
				return { result };
			} catch (error) {
				if (request.signal?.aborted) throw error;
				return { unavailable: `the sandbox failed (${error instanceof Error ? error.message : String(error)})` };
			}
		},
	};
	cleanups.push(codingRunnerRegistry().register(sandbox));

	// ── frontend operations ──────────────────────────────────────────────────────
	const handle = (name: string, fn: (input: Record<string, unknown>) => unknown) => cleanups.push(ctx.handle(name, input => fn(obj(input ?? {}))));
	handle(OPS.open, input => {
		const kind = input.kind === "question" ? "question" : "problem";
		return workspaces.open({ ...keyOf(input), kind, language: str(input.language, "language"), tests: readTests(input.tests), code: str(input.code, "code") });
	});
	handle(OPS.code, input => { workspaces.code(keyOf(input), str(input.code, "code")); return null; });
	handle(OPS.close, async input => { await workspaces.close(keyOf(input)); return null; });
	handle(OPS.get, input => workspaces.state(keyOf(input)));
	handle(OPS.run, input => workspaces.run(keyOf(input), str(input.code, "code"), ctx.signal));
	handle(OPS.narrate, input => { workspaces.narrate(keyOf(input), str(input.text, "text")); return null; });
	handle(OPS.ask, input => workspaces.ask(keyOf(input), str(input.text ?? "", "text"), str(input.code, "code")));
	handle(OPS.presence, input => { workspaces.presence(keyOf(input)); return null; });
	handle(OPS.settingsGet, () => settings);
	handle(OPS.settingsSet, input => {
		const next: CodingSettings = { listening: typeof input.listening === "boolean" ? input.listening : settings.listening };
		fs.writeFileSync(settingsFile, `${JSON.stringify(next, null, "\t")}\n`);
		settings = next;
		ctx.events.emit(TOPICS.settings, settings);
		workspaces.publishAll();
		return settings;
	});
	handle(OPS.dockerStatus, () => runner.status());
	handle(OPS.images, async () => (await runner.status()) === "running" ? runner.images() : []);
	handle(OPS.removeImages, async input => {
		const only = input.image === undefined ? undefined : str(input.image, "image");
		if (only !== undefined && !(CODE_IMAGES as readonly string[]).includes(only)) throw new Error("Unknown image");
		return runner.removeImages(only as CodeImage | undefined);
	});

	cleanups.push(...registerProjectOps(ctx, runner));

	// ── turns and listening ──────────────────────────────────────────────────────
	cleanups.push(ctx.events.on(event => {
		if (event.type === "turn-started") workspaces.turnStarted(event.chatId);
		else if (event.type === "turn-settled") workspaces.turnSettled(event.chatId);
	}));
	const ticker = setInterval(() => { void workspaces.tick().catch(error => console.error("[coding-workspaces] listening tick failed", error)); }, TICK_MS);
	ticker.unref?.();
	cleanups.push(() => clearInterval(ticker));

	// ── agent tools and instructions ─────────────────────────────────────────────
	const annotateSchema = Type.Object({
		line: Type.Integer({ minimum: 1, description: "REQUIRED — the first line (1-based) in the learner's CURRENT code." }),
		endLine: Type.Optional(Type.Integer({ minimum: 1, description: "The last line (inclusive); omit for one line." })),
		note: Type.String({ description: "REQUIRED — one or two short sentences pointing at what to look at. Never the fix itself." }),
	});
	cleanups.push(ctx.registerTools({
		agents: ["teacher", "practice"],
		hidesTurnText: ["stay_quiet"],
		create(context) {
			const annotate: Tool = {
				name: "annotate",
				label: "annotate",
				description: ANNOTATE_DESCRIPTION,
				parameters: annotateSchema,
				executionMode: "sequential",
				execute: async (_id: string, params: unknown) => {
					const input = params as { line: number; endLine?: number; note: string };
					const result = workspaces.annotate(context.chatId, input);
					if (!result.ok) throw new Error(`annotate: ${result.errors.join("; ")}`);
					return { content: [{ type: "text", text: result.text }], details: { itemId: result.itemId, annotation: result.annotation } };
				},
			};
			const stayQuiet: Tool = {
				name: "stay_quiet",
				label: "stay quiet",
				description: STAY_QUIET_DESCRIPTION,
				parameters: Type.Object({}),
				executionMode: "sequential",
				execute: async () => {
					if (!workspaces.quietAllowed(context.chatId)) throw new Error("stay_quiet: the learner asked you directly — answer them; stay_quiet is only for listening updates");
					return { content: [{ type: "text", text: "Staying quiet." }], details: {} };
				},
			};
			return [annotate, stayQuiet];
		},
	}));
	cleanups.push(ctx.registerInstructions({ agents: ["teacher", "practice"], text: instructions(SANDBOX_TOOLS) }));

	return async () => {
		for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch (error) { console.error(error); } }
		runner.dispose();
		await workspaces.dispose();
		await runner.reapAll().catch(() => {});
	};
}
