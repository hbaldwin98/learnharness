# Practice workspaces — implementation plan

Status: **DRAFT, awaiting owner approval — 2026-11-01.** Executes [practice-workspaces.md](practice-workspaces.md) (the design). Steps follow the design's §9 build order. Each step is detailed here before it is built, approved, then executed mechanically. Step 1 is detailed; steps 2–10 are outlined and get detailed one at a time.

Every step ends with: `npm run typecheck`, `npm test`, `npm run lint`, `npm run build` green; browser-verified where it has UI; one scoped commit on `practice-workspaces`.

Step 1's three open decisions were ruled on 2026-11-01 and are marked **Ruled**.

---

## Step 1 — the workspace seam

**Goal:** practice's `problem` can carry a workspace descriptor; modules register per layer; the dock switches on the module. **Ships with zero modules available**, so there is no visible or model-facing change: the problem schema, tool description and prompt are byte-identical to today when no module is available (pinned by a test).

### Why the registry is split by layer

The lint boundaries (`architecture.md` §1) forbid `components/` importing agent code and agents importing server code. So a module is not one object; it is one **id** with a piece in each layer:

| Layer | Piece | File |
|---|---|---|
| `src/core/` | The id type and the pure descriptor reader | `src/core/workspaces.ts` (new), re-exported from `src/core/index.ts` |
| `src/agent/` | Pose schema, pose verification, extra tools, availability | `src/agent/workspaces/registry.ts` (new) |
| `src/server/` | Which modules are available this turn (Docker checks land in step 2) | `src/server/chat-handler.ts` (wiring only) |
| `components/` | The workspace UI | `components/workspaces/registry.ts` (new) |

### Core — `src/core/workspaces.ts`

```ts
/** A workspace module id. "code" is the only one planned (step 2+). */
export type WorkspaceModuleId = string;

/** The workspace descriptor riding a problem call's arguments. */
export interface WorkspaceDescriptor { module: WorkspaceModuleId }

/** Read the descriptor off a problem call's input; null = the thinking field. */
export function workspaceOf(problemInput: unknown): WorkspaceDescriptor | null;
```

### Agent — `src/agent/workspaces/registry.ts`

```ts
export interface AgentWorkspaceModule {
  id: WorkspaceModuleId;
  /** The module's pose fields; composed into problem's `workspace` union
   *  with `module: Literal(id)` added by the registry. */
  poseSchema: TObject;
  /** Pose-time verification (step 2: build starter, run tests vs reference).
   *  Returns correctable error lines; [] = accept. */
  verifyPose(input: unknown, ctx: { chatId: string; problemCallId: string; signal?: AbortSignal }): Promise<string[]>;
  /** Module tools added to the practice registry (step 7: annotate). */
  tools?(ctx: { chatId: string }): Record<string, AgentTool<any>>;
}
```

`PracticeToolContext` gains `workspaceModules?: readonly AgentWorkspaceModule[]` — the modules **available this turn** (the server decides; absent/empty = none).

### `problem` tool — `src/agent/tools/practice.ts`

- `problemInputObject` stays exported unchanged (no modules). A new `problemInputSchema(modules)` returns it unchanged when `modules` is empty, else adds `workspace: Optional(Union(module schemas))`.
- `problemTool(gate, graphNodes, modules)` uses that schema. When `modules` is non-empty, the description gains one sentence naming the `workspace` field; otherwise it is unchanged.
- `execute`, after the existing gate and target checks and before `gate.problemActive = true`:
  - `workspace` present with an unknown or unavailable `module` → `invalidInputResult` ("module X is not available — omit workspace").
  - Otherwise `await module.verifyPose(input, …)`; non-empty errors → `invalidInputResult` with them. The model corrects and re-poses through the existing invalid-pose path.
- `practiceTools(ctx)` passes `ctx.workspaceModules` through and merges each module's `tools?.(…)`.

### Server — `src/server/chat-handler.ts`

Where the practitioner is constructed, pass `workspaceModules: availableWorkspaceModules()` — a new function in `src/server/workspaces.ts` that returns `[]` in step 1. Step 2 makes it Docker-aware.

### Prompt — module doctrine segments

A module's doctrine must be in the prompt whenever the module is **available**, not only while one of its problems is active, because the agent needs it to decide to pose one. (This corrects the design doc's §3 wording, "composed only when the module is active".)

**Ruled — where module doctrine files live.** The segment grammar is flat today (`practice/NN-x.md`, no nesting). A new prefix `workspace-<id>/NN-x.md` (e.g. `workspace-code/10-doctrine.md`), composed after the practice fragments only when that module is available. Overrides work through the same switch/file mechanism. Touches `src/core/prompt-segments.ts` (grammar), `src/agent/prompt-segments.ts` (discovery + conditional composition), `composeInstructions` (gets the available module ids), the prompts README, and `scripts/build-server.mjs` if prompt assets are listed by directory. In step 1 no such directory exists, so composition is unchanged.

### UI — the dock switch

- `components/workspaces/registry.ts`: `Record<WorkspaceModuleId, ComponentType<WorkspaceProps>>`, empty in step 1. `WorkspaceProps` is the module-neutral part of today's `PracticeDockProps` (`problemCallId`, `input`, `expanded`, `onExpand`, `onEscape`, `compactionRunning`) plus whatever channels later steps add.
- `components/chat.tsx` (the `DockOverlay` branch at ~line 2468): `practice` → if `workspaceOf(practice.input)` has a registered component, render it; otherwise render `PracticeDock` as today.
- **Ruled — an unknown module in a saved record** (a module later removed, or a record from a newer build): fall back to the thinking dock showing the statement, so the problem can still be worked on or dismissed.
- **Ruled — "thinking" is not a module value.** An absent `workspace` *is* the thinking field. The agent never writes `module: "thinking"`, and today's records stay canonical without migration.

The split-view layout is step 3. In step 1 a registered workspace would render where the dock renders.

### Tests — `tests/practice-workspaces.test.ts` (new)

- With no modules, the problem schema and description are byte-identical to `problemInputObject` and today's text.
- With a fake module:
  - The schema exposes `workspace`.
  - A pose with a valid descriptor that `verifyPose` accepts activates the problem.
  - `verifyPose` errors return an invalid result and leave the gate inactive.
  - An unknown module is rejected.
  - Module tools appear in the registry.
- `workspaceOf` reads `null` for today's problem inputs and the descriptor when one is present.
- `activeProblemOf` is unchanged for workspace poses; the existing practice-flow tests still pass untouched.
- A UI test for the dock switch: an unknown module falls back to `PracticeDock`.

### Docs

`architecture.md` §4 gains a short paragraph on the seam. The design doc §3 wording is corrected per the prompt note above.

---

## Steps 2–10 — outline (detailed one at a time)

2. **Runner.**
   - Docker detection; installed → module available, not running → the pose is refused with "start Docker".
   - Dockerfiles in the repo per language with the test framework and language server.
   - Image build with progress.
   - Warm container per active problem (start on pose, tear down on conclude, dismiss and app exit, reap orphans at startup).
   - Lockdown and limits; run/test execution.
   - `verifyPose` for code: build the starter, run all tests against the reference.
   - The `code` pose schema (language, files, visible and hidden tests, reference solution).
   - Before writing any route, read the Next.js guides in `node_modules/next/dist/docs/` (AGENTS.md).
3. **Editor + workspace UI.** Split view, CodeMirror 6, multi-file tree, output panel, Run/Submit, the `data/workspaces/` autosave store, restore on reload.
4. **Language servers.** A stdio ↔ browser relay through the server; diagnostics-only client capabilities; a server per language.
5. **Trace + Ask.** The narration strip as the dictation target; trace markers (snapshots and diffs, run and submit results, asks) in the record; the Ask button and hotkey; the computed outcome fields.
6. **Listening.** The four cues, the cap and coalescing, the `stay_quiet` tool and its faint transcript line, the global setting; delivery through the existing wake path.
7. **Annotations.** The agent tool; anchors that follow edits; the outdated list.
8. **Settings.** The Coding section: default language, listening, Docker status and image management.
9. **Teacher exercises.** The teaching tool and its Tools toggle; an inline split view in the lesson; a quiz-style result back to the teacher.
10. **Doctrine.** Owner-authored interview-style, coding and teacher-exercise sections.
