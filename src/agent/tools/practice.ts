/**
 * THE PRACTICE TOOLS (practice sessions, owner design 2026-10-04): the
 * practice agent's ENTIRE toolset — `problem` (pose: terminates the turn;
 * the commitment rides the call's arguments, hidden from the learner UI)
 * and `conclude` (end the problem: normal result, the turn continues so
 * the same reply can reveal + pose the next). The gating law (owner
 * ruling): an agent cannot pose while a problem is active and cannot
 * conclude with nothing active — activeProblemOf is the single fold both
 * gates read.
 *
 * Mechanics-only descriptions (the doctrine ruling, 2026-10-04): the tool
 * descriptions carry WHAT to pass and WHAT happens — the theory, the
 * commit-before-pose law, the hint ladder all live in the system prompt
 * (prompts/practice/10-doctrine.md).
 */

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveTargetId } from "../../core/chains.ts";
import { readTool } from "./read.ts";
import { lsTool } from "./ls.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { jobTools, type JobToolContext } from "./jobs.ts";
import { proberGraphTools, type GraphToolContext } from "./graph.ts";
import { activeProblemOf, passingSubmissionOf } from "../../core/native-messages.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { concludeResult, invalidInputResult, problemResult } from "../tool-execute.ts";
import { healEncodedArguments, healToolRecord } from "./heal.ts";
import { workspaceOf } from "../../core/workspaces.ts";
import { moduleFor, workspaceFieldSchema, type AgentWorkspaceModule } from "../workspaces/registry.ts";


/** The record-reading context the gates need (the plan-tools idiom). */
export interface PracticeToolContext {
	chatId: string;
	chatStore: { getChat(id: string): { messages: LhMessage[]; kind?: string } | null };
	/** The WHOLE-graph node list, read fresh per pose (owner round 9 — the
	 *  mastery-trace contract): targets validate against every proposition,
	 *  not just the session's picks, so pickless sessions and future
	 *  graph-tools poses stay valid. Absent (tests) = no validation. */
	graphNodes?: () => ReadonlyArray<Pick<import("../../core/contracts/graph.ts").GraphNode, "id" | "name">>;
	/** THE RARELY-NEEDED SET (owner round 10, 2026-10-05): the map readers
	 *  behind the SAME settings gate as the prober's (graphToolsEnabled at
	 *  the composition root); the research + pdf jobs (both keyless).
	 *  Each absent context (tests) = absent from the registry. */
	graph?: GraphToolContext;
	jobs?: JobToolContext;
	/** PRACTICE WORKSPACES (plan step 1): the modules AVAILABLE this turn —
	 *  the server decides (src/server/workspaces.ts). Absent/empty = none:
	 *  the problem schema, description and prompt are today's exactly. */
	workspaceModules?: readonly AgentWorkspaceModule[];
}

/** TURN-SCOPED GATE STATE (the BKT incident, 2026-10-05): the gates used
 *  to read the STORED record — but the record freezes at the turn's
 *  write-ahead (persistTurn lands only at turn END), so a mid-turn
 *  conclude → pose pair could never see each other: every conclude
 *  succeeded against the stale record and every following pose died on
 *  "a problem is already active" until the model gave up ("the problem
 *  slot is stuck"). The gate seeds ONCE from the record at construction
 *  (one practiceTools per turn — chat-handler builds the agent per
 *  request, so there is no cross-turn leakage), and the executes flip
 *  this closure — the intra-turn truth the record cannot hold yet. */
export interface PracticeGate {
	problemActive: boolean;
	/** The active problem has a workspace and no Submit that passed every
	 *  test yet (owner ruling 2026-11-01: a workspace problem is solved only
	 *  after a passing Submit). */
	needsPassingSubmit: boolean;
}

/** Seed the turn's gate from the record (result-aware activeProblemOf —
 *  only a cleanly-posed problem counts). */
export function createPracticeGate(ctx: PracticeToolContext): PracticeGate {
	const record = ctx.chatStore.getChat(ctx.chatId);
	const active = record ? activeProblemOf(record.messages) : null;
	return {
		problemActive: active !== null,
		needsPassingSubmit:
			active !== null && workspaceOf(active.input) !== null && !passingSubmissionOf(record!.messages, active.toolCallId),
	};
}

/** The outcomes that need a passing Submit on a workspace problem. */
const SOLVED_OUTCOMES: ReadonlySet<string> = new Set(["solved", "solvedWithHints"]);

// ─── problem: the pose ───────────────────────────────────────────────────────

export const problemInputObject = Type.Object({
	statement: Type.String({
		description:
			"REQUIRED — the problem as the learner sees it (markdown + LaTeX). Must be self-contained and " +
			"solvable from the session's material. NEVER announces the target proposition.",
	}),
	mode: Type.Union([Type.Literal("recall"), Type.Literal("discrimination"), Type.Literal("composition")], {
		description: "REQUIRED — the demand mode: recall, discrimination, or composition (bare words, no quotes).",
	}),
	target: Type.Optional(
		Type.Array(Type.String(), {
			minItems: 1,
			description:
				"The proposition id(s) this problem exercises, from the session context's [id] list — include when " +
				"the material is in the map; OMIT entirely when it is not (a topic session poses untagged problems). " +
				"Names are normalized to ids at the seam; an unknown proposition is rejected.",
		}),
	),
	modelSolution: Type.String({
		description: "REQUIRED — the full solution, moves in order, committed BEFORE the learner sees the problem. This IS the reveal — conclude shows it verbatim; never re-author it.",
	}),
});

export type ProblemInput = Static<typeof problemInputObject>;

/** The problem schema for the modules available this turn (practice
 *  workspaces, plan step 1): with none, exactly problemInputObject. */
export function problemInputSchema(modules: readonly AgentWorkspaceModule[] = []): typeof problemInputObject {
	const workspace = workspaceFieldSchema(modules);
	if (workspace === null) return problemInputObject;
	return Type.Object({ ...problemInputObject.properties, workspace }) as unknown as typeof problemInputObject;
}

const PROBLEM_DESCRIPTION =
	"Pose one practice problem. Ends the turn — the learner works in the thinking field; their thinking " +
	"traces and answer commits arrive back as labeled messages. The modelSolution rides this call's " +
	"arguments and stays hidden from the learner until you conclude (conclude shows it verbatim — the " +
	"reveal needs no new field). Only one problem may be active — conclude it before posing the next.";

const WORKSPACE_DESCRIPTION_SUFFIX =
	" A `workspace` gives the learner a workspace beside the transcript; the pose is verified before it goes through. A workspace problem concludes solved only after the learner's Submit passes every test." +
	" While working they narrate aloud into the workspace without reaching you; their narration, Runs, code changes since you last looked and the editor's errors arrive together as a trace with their next Ask (a direct request for your help), Submit, or thinking message.";

export function problemTool(
	gate: PracticeGate,
	graphNodes?: PracticeToolContext["graphNodes"],
	modules: readonly AgentWorkspaceModule[] = [],
	chatId = "",
): AgentTool<typeof problemInputObject> {
	const parameters = problemInputSchema(modules);
	return {
		name: "problem",
		label: "problem",
		description: modules.length === 0 ? PROBLEM_DESCRIPTION : PROBLEM_DESCRIPTION + WORKSPACE_DESCRIPTION_SUFFIX,
		parameters,
		executionMode: "sequential",
		prepareArguments: (args: unknown) => {
			const healed = healEncodedArguments(args, parameters);
			// TARGET NORMALIZATION (owner round 9): names silently become ids —
			// the RECORD carries canonical ids (the mastery trace groups on
			// them); unresolvable strings pass through for execute to reject.
			// UNTAGGED PROBLEMS (owner round 12): an explicit empty list is
			// the model saying "no targets" — healed AWAY, so the record's
			// canonical form is tagged-or-absent, never [].
			if (!graphNodes) {
				const bare = (healed as { target?: unknown }).target;
				return Array.isArray(bare) && bare.length === 0
					? ({ ...(healed as Record<string, unknown>), target: undefined } as never)
					: (healed as never);
			}
			const target = (healed as { target?: unknown }).target;
			if (!Array.isArray(target) || target.length === 0) {
				return { ...(healed as Record<string, unknown>), target: undefined } as never;
			}
			const list = graphNodes();
			const normalized = target.map((t) =>
				typeof t === "string" ? (resolveTargetId(t, list) ?? t) : t,
			);
			if (normalized.every((t, i) => t === target[i])) return healed as never;
			return { ...(healed as Record<string, unknown>), target: normalized } as never;
		},
		execute: async (toolCallId, input, signal, onUpdate) => {
			if (gate.problemActive) {
				return invalidInputResult("problem", [
					"a problem is already active — call conclude on it before posing the next one",
				]);
			}
			// TARGET VALIDATION (owner round 9, round 12): against the WHOLE
			// graph, and ONLY when targets are present — absent means an
			// untagged problem (topic sessions, owner round 12), which poses
			// freely. A one-line rejection — the proposition list already
			// sits in the agent's context (the [id] marker); no re-listing.
			// The message teaches the exit: omitting always works.
			if (graphNodes && input.target && input.target.length > 0) {
				const list = graphNodes();
				const unknown = input.target.filter((t) => resolveTargetId(t, list) === null);
				if (unknown.length > 0) {
					return invalidInputResult("problem", [
						`target ${JSON.stringify(unknown)} is not a known proposition — targets must be proposition ids from the session context; if the material is not in the map, omit target entirely`,
					]);
				}
			}
			// WORKSPACE VERIFICATION (practice workspaces, plan step 1): a
			// workspace must name an available module, and that module must
			// accept the pose — otherwise a correctable invalid result, the
			// gate stays closed, and the model re-poses.
			const workspace = (input as { workspace?: unknown }).workspace;
			if (workspace !== undefined) {
				const descriptor = workspaceOf(input);
				const workspaceModule = descriptor ? moduleFor(modules, descriptor.module) : undefined;
				if (!workspaceModule) {
					const named = descriptor ? JSON.stringify(descriptor.module) : "no module";
					return invalidInputResult("problem", [
						`workspace module ${named} is not available — omit workspace for an ordinary problem`,
					]);
				}
				const errors = await workspaceModule.verifyPose(workspace, {
					chatId,
					problemCallId: toolCallId,
					signal,
					...(onUpdate ? { onProgress: (line: string) => onUpdate({ content: [{ type: "text", text: line }], details: undefined }) } : {}),
				});
				if (errors.length > 0) return invalidInputResult("problem", errors);
			}
			gate.problemActive = true;
			gate.needsPassingSubmit = workspace !== undefined;
			return problemResult();
		},
	};
}

// ─── conclude: the end of a problem ──────────────────────────────────────────

export const concludeInputObject = Type.Object({
	outcome: Type.Union(
		[
			Type.Literal("solved"),
			Type.Literal("solvedWithHints"),
			Type.Literal("movedOn"),
			Type.Literal("surrendered"),
			Type.Literal("dismissed"),
		],
		{ description: "REQUIRED — the outcome: solved, solvedWithHints, movedOn, or surrendered — bare words, no quotes (dismissed is synthesized, never yours)." },
	),
	verdict: Type.String({
		description: "REQUIRED — the plain-language verdict: what was credited, where it broke. On a wrong answer: localize the break, do NOT give the correction.",
	}),
	rung: Type.Union(
		[Type.Literal("R0"), Type.Literal("R1"), Type.Literal("R2"), Type.Literal("R3"), Type.Literal("R4"), Type.Literal("R5"), Type.Null()],
		{ description: "REQUIRED — the hint-ladder rung the problem needed: R0 through R5, or null = no hint was given (bare, no quotes)." },
	),
	missClass: Type.Union(
		[
			Type.Literal("cue"),
			Type.Literal("discrimination"),
			Type.Literal("execution"),
			Type.Literal("careless"),
			Type.Literal("structural"),
			Type.Null(),
		],
		{ description: "REQUIRED — the miss classification: cue, discrimination, execution, careless, or structural — or null = no miss (bare, no quotes)." },
	),
	retest: Type.Boolean({ description: "REQUIRED — true marks the problem for a fresh-surface retest before the session ends." }),
});

export type ConcludeInput = Static<typeof concludeInputObject>;

export function concludeTool(gate: PracticeGate): AgentTool<typeof concludeInputObject> {
	return {
		name: "conclude",
		label: "conclude",
		description:
			"Conclude the active problem: records the outcome + verdict, reveals the committed solution, and frees " +
			"the learner's composer. After the result, say your closing words about the learner's work if useful, then " +
			"END YOUR TURN — no further tool calls. The next problem is NEVER posed here: it waits for the learner's " +
			"explicit go-ahead (a *Next problem* message, or their own words asking for the next one). Between problems, " +
			"answer their questions about the concluded one. Nothing may conclude unless a problem is active.",
		parameters: concludeInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, concludeInputObject) as never,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			if (!gate.problemActive) {
				return invalidInputResult("conclude", ["no active problem to conclude — pose one first"]);
			}
			if (gate.needsPassingSubmit && SOLVED_OUTCOMES.has(input.outcome)) {
				return invalidInputResult("conclude", [
					"this workspace problem has no Submit that passed every test (visible and hidden) — it can't be solved yet. " +
						"Ask the learner to Submit, and conclude after the submission arrives; or conclude as movedOn or surrendered",
				]);
			}
			gate.problemActive = false;
			gate.needsPassingSubmit = false;
			return concludeResult();
		},
	};
}

/** The practice toolset (the practice agent's whole registry). */
export function practiceTools(ctx: PracticeToolContext): Record<string, AgentTool<any>> {
	// ONE gate per turn, shared by both tools — the intra-turn truth.
	const gate = createPracticeGate(ctx);
	// THE RARELY-NEEDED SET (owner round 10): read/ls/find/grep over the
	// learner's files (always — the same read-only set the teacher and
	// prober carry), the research + pdf jobs (available without search
	// keys; demo/visual stay teach-only), and
	// the prober's map readers when the settings gate opened. None are
	// toggle-filtered: problem/conclude are the session; these are
	// exceptions the doctrine says to reach for rarely.
	const jobs = ctx.jobs ? jobTools(ctx.jobs) : null;
	const modules = ctx.workspaceModules ?? [];
	const moduleTools = Object.assign({}, ...modules.map((m) => m.tools?.({ chatId: ctx.chatId }) ?? {})) as Record<string, AgentTool<any>>;
	// healToolRecord (owner, 2026-10-09 — the whitehead generalization):
	// the standard argument heal over the WHOLE registry. problem/conclude
	// keep their own (target-normalizing) prepareArguments as the composed
	// inner pass; the double heal is idempotent by construction.
	return healToolRecord({
		problem: problemTool(gate, ctx.graphNodes, modules, ctx.chatId),
		conclude: concludeTool(gate),
		read: readTool,
		ls: lsTool,
		find: findTool,
		grep: grepTool,
		...(jobs?.research ? { research: jobs.research } : {}),
		...(jobs ? { pdf: jobs.pdf! } : {}),
		...(ctx.graph ? proberGraphTools(ctx.graph) : {}),
		...moduleTools,
	});
}
