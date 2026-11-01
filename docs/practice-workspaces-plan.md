# Practice workspaces — implementation plan

Status: **DRAFT, awaiting owner approval — 2026-11-01.** Executes [practice-workspaces.md](practice-workspaces.md) (the design). Steps follow the design's §9 build order. Each step is detailed here before it is built, approved, then executed mechanically. Step 1 is detailed; steps 2–10 are outlined and get detailed one at a time.

Every step ends with: `npm run typecheck`, `npm test`, `npm run lint`, `npm run build` green; browser-verified where it has UI; one scoped commit on `practice-workspaces`.

Step 1's three open decisions were ruled on 2026-11-01 and are marked **Ruled**.

---

## Step 1 — the workspace seam (BUILT 2026-11-01)

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

## Step 2 — the Docker runner and the `code` module (BUILT 2026-11-01)

**Goal:** the `code` module becomes available when Docker is installed. The agent can pose a coding problem in any of the eight languages, and the pose goes through only after the app has built the starter and passed every test against the reference solution, inside a locked-down container. No learner UI yet (step 3), so the learner sees an ordinary problem; this step is verified through tests and a scripted live pose.

### Layering

| Piece | Where | Why there |
|---|---|---|
| `CodeRunner` port (interface) and the `code` module (pose schema, `verifyPose`) | `src/agent/workspaces/code/` | Agents may not import server code; the module receives the runner through its constructor. |
| Docker CLI runner (implements the port) | `src/server/workspaces/docker-runner.ts` | External effects and process lifecycle are server concerns. |
| Language table (images, scaffolds, run and test commands, result parsing) | `src/agent/workspaces/code/languages.ts` | Pure data plus parsers, shared by the module and the runner. |
| Dockerfiles | `docker/workspace-code/<language>/Dockerfile` | Built locally (ruled); shipped in the packaged app. |
| Availability | `src/server/workspaces.ts` | Registers the module when Docker is installed. |

**Ruled — talking to Docker: the `docker` CLI.** Spawn the `docker` CLI (`child_process`), as the app already does for Claude Code, rather than adding a Docker Engine API client dependency. It works the same with Docker Desktop on Windows, macOS and Linux.

### Availability

- **Installed** (`docker --version` succeeds) → the `code` module is registered, so its schema field and doctrine reach the agent.
- **Running** (`docker info` succeeds) is checked at pose time; when it fails, the pose is refused with "Docker isn't running — start Docker Desktop and pose again".
- Both results are cached for 30 s so a turn doesn't spawn `docker` repeatedly.

### Languages, images and scaffolds

Eight languages, one image each, tagged `learnharness-code-<language>:<hash of its Dockerfile>` so an edited Dockerfile rebuilds automatically.

| Language | Base image | Tests | App-provided scaffold | Run tests |
|---|---|---|---|---|
| JavaScript | `node:24-slim` | `node:test` | — | `node --test --test-reporter=junit` |
| TypeScript | `node:24-slim` | `node:test` (types stripped by Node) | — | same |
| Python | `python:3.13-slim` | pytest | — | `pytest --junitxml` |
| C# | `mcr.microsoft.com/dotnet/sdk:9.0` | xUnit | `Solution.csproj` with xUnit packages restored into the image | `dotnet test` with a JUnit/TRX logger |
| Java | `eclipse-temurin:21-jdk` | JUnit 5 | JUnit console standalone jar in the image | `javac` then the console launcher with XML reports |
| Go | `golang:1.24` | `go test` | `go.mod` | `go test -json` |
| Rust | `rust:1-slim` | `cargo test` | `Cargo.toml` (a lib crate), dependencies pre-fetched | `cargo test` (libtest output parsed) |
| C++ | `gcc:14` | doctest | `doctest.h` in the image | `g++` all sources, run with the JUnit reporter |

Images contain no network-dependent steps at run time. Language servers join these images in step 4.

**Ruled — scaffold convention:** the app supplies the per-language project files above (csproj, go.mod, Cargo.toml…), so the agent only writes source and test files. The tool description states each language's file layout (e.g. Rust: `src/lib.rs` plus `tests/*.rs`; Go: one package with `*_test.go`). A pose that writes a scaffold file is refused.

### The `code` pose schema

```ts
workspace: {
  module: "code",
  language: "javascript" | "typescript" | "python" | "csharp" | "java" | "go" | "rust" | "cpp",
  files:     [{ path, content }],   // starter — what the learner sees and edits
  tests:     { visible: [{ path, content }], hidden: [{ path, content }] },
  reference: [{ path, content }],   // the reference solution, replacing starter files by path
}
```

Paths are relative and validated (no `..`, no absolute paths, no scaffold files, no collisions between starter, test and reference sets). The existing `modelSolution` stays: prose for the reveal; `reference` is its runnable form.

### `verifyPose`

1. Docker running? Otherwise the "start Docker" refusal.
2. Image present? (See the ⚑ on first use below.)
3. Start the problem's warm container.
4. **Reference run:** starter overlaid by the reference, plus visible and hidden tests. Every test must pass, and there must be at least one visible and one hidden test.
5. **Starter build:** starter plus visible tests must compile or load. Test *failures* are expected (the starter is unsolved); a compile/syntax error is a refusal. For interpreted languages, "builds" means the test runner collects the tests without an import or syntax error.
6. Any failure returns the build/test output (truncated to the agent's 8 KB) as correctable errors; the container is torn down.

**Ruled — first use of a language: the pose waits and shows progress.** When the image isn't built yet (minutes; roughly 1 GB for .NET, 1.5 GB for Rust), `verifyPose` builds it before continuing. Progress (the current build step) goes out through the tool's `onUpdate` channel and shows as the pose's live activity label. The server already streams `tool_execution_update` events (`src/server/pi/ui-stream.ts`); if the browser projection doesn't yet surface them on the live tool card, this step adds that. One build per language runs at a time; a second pose waiting on the same build joins it. A failed build refuses the pose with the build output. The build has no 60 s limit; aborting the turn cancels it.

### Containers

- **One warm container per active problem**, created at pose verification and reused for every later Run/Submit (step 3). Name `lh-code-<chatId>-<problemCallId>`, label `learnharness.workspace=code`.
- **Lockdown:** `--network none`, `--read-only`, `--tmpfs /work` and `/tmp`, non-root user, `--memory 1g --memory-swap 1g`, `--cpus 2`, `--pids-limit 256`, `--security-opt no-new-privileges`, `--cap-drop ALL`. Main process `sleep infinity`.
- **Each run gets a fresh directory** under `/work/<runId>`. Files go in by piping a tar stream into `docker exec -i … tar -x`, so no host directory is ever mounted. Build caches (cargo, dotnet, go) live in the container's tmpfs and persist between runs of the same problem.
- **Hidden tests enter the container only for Submit and pose verification**, never for Run, so the learner's code can't read them.
- **Limits (ruled):** a build is killed after 60 s and a test run after 10 s (`timeout` inside the container plus a host-side kill). Output is capped at 64 KB, of which 8 KB goes to the agent.
- **Teardown:** on `conclude`; on problem dismissal (the server's dismissal path); after 30 minutes idle; and at server startup, every container with the label is removed. A problem whose container is gone recreates it lazily on its next run.

### Cleanup — nothing lingers (owner, 2026-11-01)

- **Containers:** started with `--rm`, so a stopped container deletes itself. Removed explicitly on conclude, on dismissal, after 30 minutes idle and at server startup (every container labelled `learnharness.workspace=code`).
- **No volumes and no host mounts.** All files live in tmpfs inside the container and vanish with it.
- **Run directories** are deleted after each run.
- **Images (ruled): kept until removed.** A language's image stays so later problems start fast; Settings (step 8) lists them with sizes and a Remove button. When a Dockerfile changes, the rebuilt image replaces it and the superseded `learnharness-code-<language>:<old hash>` image is deleted right away.
- **Known limit:** Docker's own build cache and the pulled base images (e.g. `node:24-slim`) are shared with anything else on the machine, so the app does not prune them. Removing a language in Settings removes the app's image only.

### Results

Every run returns one normalized shape: `{ phase: "build" | "test", ok, timedOut, exitCode, output, tests: [{ name, file, status: "pass" | "fail" | "error", message }] }`. Each language's parser maps its native report (JUnit XML, `go test -json`, libtest text) into it. Step 3 renders it; step 5 records it in the trace.

### Packaging

The Dockerfiles join `outputFileTracingIncludes` in `next.config.ts` and the asset sanity check in `scripts/build-server.mjs`, so the packaged app can build images.

### Tests

- **Unit (no Docker):** path validation; schema shape; each language's result parser on recorded fixtures; the run-command table; `verifyPose` against a fake runner (Docker not running, reference failing, starter not building, success); availability caching; container naming and teardown calls.
- **Docker integration (skipped when Docker isn't running):** for each language, a small fixture problem (reverse a list) verifies end to end: the reference passes, a broken reference is refused, a starter with a syntax error is refused, an infinite loop times out, and the network is unreachable.
- **Live check:** with Docker running, a real practice turn poses a coding problem; the pose goes through and the container exists, then conclude removes it.
  **Deferred to step 3 (owner, 2026-11-01)**, where the live check covers the whole loop with the editor in place.

---

## Step 2b — switch the runner to the Docker SDK (BUILT 2026-11-01)

**Why:** measured on Windows, about 2 s of every Run (out of ~3.6 s for Python) was `docker` CLI process overhead — five process starts at ~400 ms each. **Owner ruling (2026-11-01): switch to the SDK.** The `CodeRunner` port, the module, the language table, the images and every behaviour of step 2 stay the same; only `src/server/workspaces/docker-runner.ts` changes underneath.

**Rulings:**
- **dockerode 5.0.1** (latest), pinned exactly.
- **Typed by our own narrow declarations** (`src/server/workspaces/dockerode.d.ts`) covering only the calls the runner makes — no `@types/dockerode`.
- **Engine discovery:** (1) `DOCKER_HOST` if set (dockerode reads it, with the TLS variables); (2) otherwise the current context — `DOCKER_CONTEXT` or `currentContext` in `~/.docker/config.json`, its endpoint read from `~/.docker/contexts/meta/<sha256(name)>/meta.json` (unix, npipe, tcp with the context's TLS files, ssh); (3) otherwise the platform default (`//./pipe/docker_engine` on Windows; `/var/run/docker.sock`, then `~/.docker/run/docker.sock`).

**How each operation maps:**

| Operation | CLI today | SDK |
|---|---|---|
| Installed? | binary on disk | unchanged: a filesystem check for the binary, or a configured `DOCKER_HOST`/context — no process is started |
| Running? | `docker info` | `docker.ping()` |
| Image present / build | `image inspect`, `build --progress=plain` | `getImage(tag).inspect()`; `buildImage` with the image directory sent as a tar (the existing encoder, extended to binary content), progress from the JSON stream's `Step N/M` lines |
| Superseded images | `images` + `rmi` | `listImages` filtered by reference + `getImage().remove()` |
| Containers | `run`, `inspect`, `rm -f`, `ps --filter` | `createContainer` + `start` with the same HostConfig lockdown and `AutoRemove`; `inspect`; `remove({ force: true })`; `listContainers` by label |
| A run | 5 `docker exec` processes | the same steps as exec calls over one connection: wipe+scaffold, tar on stdin, build, test, read report, wipe — each exec's exit code from `exec.inspect()`, stdout/stderr split with `modem.demuxStream` |

Files still go in by tar on an exec's stdin, not the archive API (a copy into a tmpfs mount is not visible inside the container). Timeouts are unchanged (`timeout` inside, host-side backstop that removes the container).

**Packaging:** `dockerode` (and its `ssh2` dependency, whose native add-on is optional) joins `serverExternalPackages`; whatever the standalone trace misses joins `outputFileTracingIncludes`, with the pinned packaging tests updated. The desktop build's smoke checks must still pass.

**Tests:** the unit suite is unchanged except where it touched CLI details; a new unit test covers engine discovery (env, context metadata, defaults) against temp config directories; the real-Docker suite must pass again in all eight languages; the timing script is re-run and the per-run overhead reported.

**Measured after the switch (Windows, Docker Desktop):** a warm Python Run fell from ~3.6 s to ~0.95 s; pure Docker overhead per run from 1,953 ms to 201 ms; the real-Docker suite from 370 s to 205 s, all 33 cases passing in all eight languages. An API image build, the superseded-tag deletion and the standalone payload loading dockerode were each checked directly.

## Step 3 — the editor and workspace UI (BUILT 2026-11-01)

**Goal:** a coding problem opens a code workspace beside the transcript; the learner edits, runs the visible tests, talks to the agent through the thinking dock, and submits. Ends with the deferred live check from step 2: a real practice turn poses a coding problem and the whole loop runs in the app.

**Owner rulings (2026-11-01):**
- **Talk channel:** the transcript side keeps today's thinking dock; each thinking message also carries a snapshot of the current code.
- **Submit:** runs visible and hidden tests, shows results (hidden as counts), and sends the agent a submission message with the code and results, starting its turn.
- **Run:** builds and runs the visible tests only; nothing goes to the agent.
- **Files:** the learner edits the starter files' contents only — no add/rename/delete. Visible tests show read-only.
- **Hotkeys:** Run `Mod+'`, Submit `Mod+Shift+Enter`, both in the rebindable registry.
- **Split view:** workspace on the right with a resizable divider remembered on this device; below `lg` it overlays the transcript with a toggle back; while it's open the readings tray opens as an overlay.
- **Vim mode:** `@replit/codemirror-vim`, **on by default**, toggled in the workspace toolbar and in Settings → Keyboard, stored on this device (localStorage, like the keymap). A mode indicator shows NORMAL/INSERT/VISUAL. **While the editor has focus, Esc belongs to the editor** — it never dismisses the problem or stops dictation.

**Defaulted (recommended, owner 2026-11-01: "go with the recommended for minor questions"):**
- **Trusted server state.** The client never sends test results or tests. Live files autosave (debounced) to `data/workspaces/<chatId>/<problemCallId>.json`; Run/Submit and the thinking snapshot read the files from that store (the client flushes before acting) and the tests from the pose in the record.
- **Routes:** `GET`/`PUT /api/workspaces/[chatId]/[problemCallId]` (load — starter files when nothing saved — and save, paths limited to the starter set and size-capped); `POST …/run` with `{ mode: "run" | "submit" }` returning the normalized result.
- **Submit → agent:** Submit stores its result in the workspace store, then the client sends a new chat input `{ type: "submission", problemCallId }`; the server appends a `practice-submission` marker (files + results) from the stored result and starts the turn through the normal admission path.
- **Hidden counts:** Submit runs the visible tests and the full set; tests not in the visible run are the hidden ones (language-agnostic, at the cost of a second run).
- **Thinking snapshot:** the `practice-thinking` marker gains an optional `code` (the stored files); the model sees the files as fenced blocks after the thinking text.
- **Transcript cards:** the thinking card shows a collapsed "code" section; a submission card shows passed/failed counts and failing visible tests; the conclusion card also reveals the reference files and all tests.
- **Editor packages:** CodeMirror 6 with the official language packages (JS/TS, Python, Java, C++, Rust, Go) and C# through `@codemirror/legacy-modes`; theme from the app's CSS variables; versions pinned exactly (`@lezer/highlight` 1.2.5 pinned directly for the token colours).
- **The pane, not the dock (built 2026-11-01):** the step 1 registry now maps a module to the pane beside the transcript (loaded on demand, never prerendered); the dock is always the thinking dock. An unknown module gets no pane — the thinking dock alone, as step 1 ruled.
- **Editor keys:** with the editor focused, Esc, Tab (indents) and any key the editor itself handled (Vim's Ctrl-D, the editor's own find) stay in the editor; Run, Submit and dictation still reach the app's shortcuts. The mode indicator is Vim's own status line at the bottom of the editor (it also carries `:` commands and `/` search).
- **Split:** the divider stores a fraction (25–75 %, default 50 %, double-click resets) under `lh:workspace-split`; a header **Code** chip hides and shows the pane (a new problem opens it again). Below `lg` the pane is a full-screen overlay with a back button.
- **Readings tray:** practice sessions have no readings today, so the tray rule has nothing to act on yet; it applies when step 9 brings workspaces into lessons.
- **Submit while the agent is talking:** disabled until its turn ends (the button says why).
- **Results panel:** the last Run or Submit (whichever is newer) restores on load.

**Built (2026-11-01):** the store, routes and server run path; the `submission` input and marker; the thinking snapshot; the cards; the pane (CodeMirror, tabs with read-only tests, Run/Submit, results, autosave with flush, Vim toggle); the split view and Code chip; the two registry hotkeys; the Settings → Keyboard Vim row. Tests: `tests/code-workspace-ui.test.ts` (store, Run/Submit against a fake runner with hidden counts, inputs, projection, absorption).

**Live check (2026-11-01, PASSED):** the worktree's dev server on a fresh data dir, the owner's model (Claude Code CLI, opus), headless Chromium driven by puppeteer. In one practice session: (1) the agent posed a Python `rev(xs)` problem; the pane opened with `solution.py` and the read-only `test_solution.py`; Run on the starter showed 0/2 with the pytest failures; a Vim edit (`ggdG`, insert), with the status line reading `--NORMAL--` and Esc leaving the problem active; Ctrl+' ran 2/2; thinking sent with the code snapshot (the "Your code" disclosure); the agent concluded *solved* from the snapshot; the pane closed and the conclude card revealed the reference and all tests. (2) A second problem (`total(xs)`) went straight to Submit: the submission card read "All tests pass · visible 2/2 · hidden 1/1", the agent got the marker and concluded *solved*. Both containers were gone once each turn settled; the saved files sat in `data/workspaces/<chatId>/`.

**Noted, not fixed:** Python auto-indent leaves a whitespace-only last line in typed code (cosmetic); in run (1) the agent concluded on the thinking alone without asking for a Submit, so the hidden tests never ran (its claim that they passed was its own inference). 

**Owner ruling (2026-11-01): a workspace problem is solved only after a Submit that passed every test.** Enforced in the `conclude` tool, not only the prompt: on a workspace problem, `solved` and `solvedWithHints` are refused until the record holds a `practice-submission` for that problem whose result passed every visible and hidden test (`passingSubmissionOf`). The refusal tells the agent to ask the learner to Submit, or to conclude `movedOn`/`surrendered`; a problem posed in the same turn can't be solved in that turn. The problem tool's description says so up front. Tests in `tests/practice-workspaces.test.ts`.

---

## Steps 4–10 — outline (detailed one at a time)

4. **Language servers.** A stdio ↔ browser relay through the server; diagnostics-only client capabilities; a server per language.
5. **Trace + Ask.** The narration strip as the dictation target; trace markers (snapshots and diffs, run and submit results, asks) in the record; the Ask button and hotkey; the computed outcome fields.
6. **Listening.** The four cues, the cap and coalescing, the `stay_quiet` tool and its faint transcript line, the global setting; delivery through the existing wake path.
7. **Annotations.** The agent tool; anchors that follow edits; the outdated list.
8. **Settings.** The Coding section: default language, listening, Docker status and image management.
9. **Teacher exercises.** The teaching tool and its Tools toggle; an inline split view in the lesson; a quiz-style result back to the teacher.
10. **Doctrine.** Owner-authored interview-style, coding and teacher-exercise sections.
