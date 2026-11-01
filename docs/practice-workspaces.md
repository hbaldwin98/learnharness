# Practice workspaces — coding challenges as the first module

Status: **DESIGN RULED, NOT BUILT — 2026-11-01.** Drafted from an owner design conversation and a read of the as-built system (`architecture.md` §4, `src/agent/tools/practice.ts`, `components/practice-dock.tsx`, `components/dictation.tsx`, `prompts/practice/10-doctrine.md`). Nothing here is built. Rulings taken in that conversation are marked **(ruled)**. The remaining open questions were ruled the same day at the recommended defaults — §10 records them. Nothing is open.

---

## 1. The idea

A **workspace** is a richer place to work on a practice problem than the "Your thinking" field. The first workspace module is **coding**: a multi-file editor with live errors, a sandboxed runner, tests, and an optional spoken think-aloud trace — LeetCode-shaped problems solved *with* the practice agent, not against a judge.

Coding is the first module of a general seam, not a one-off **(ruled: seam now, coding first)**. Other topics (SQL, math, …) can plug in later as their own modules; none are built now.

It lives **inside practice**, not as a new session kind **(ruled)**. Practice already owns the right loop: `problem` commits the statement and a hidden model solution before the learner sees it; one problem is active at a time; `conclude` records an outcome and reveals the solution; outcomes are session evidence tied to graph targets.

## 2. Style is read from the request

There is no mode picker **(ruled)**. The learner says what they want — "drill me on BFS" or "interview-style problems, medium difficulty" — and the agent shapes the session. A session holds several problems of that type, posed and concluded in sequence as practice does today.

**Doctrine amendment required.** The doctrine (`prompts/practice/10-doctrine.md` §I) currently says practice is *"Not search training. Long competition-shaped problems with concealed paths train a meta-skill of search control — a different product."* Interview-style work is exactly that product. The proposal: a new doctrine section, owner-authored or owner-approved, stating that when the learner **asks** for interview-style work, longer search-heavy problems are the product, and how the hint ladder, verdicts, and the decision-points-per-minute metric change for them. The concept-drill path keeps the current doctrine unchanged. The coding module also needs its own doctrine section (narration-aware nudging, line annotations, test authoring discipline). Neither is drafted here — prompt wording is the owner's.

## 3. The workspace seam

`problem` gains an optional workspace descriptor. Absent = today's thinking field; nothing about existing records changes.

```ts
// sketch — field names are proposals
problem({
  statement, mode, target?, modelSolution,
  workspace?: { module: "code", ...moduleSpecificPose }
})
```

A **module** supplies:

| Piece | What it is | Coding module |
|---|---|---|
| Pose schema + validation | Extra `problem` arguments and the pose-time check | Files, language, tests, reference solution (§5) |
| Workspace UI | Replaces the practice dock's thinking field | Editor, file tree, run/test output, narration strip (§7) |
| Runner | Server-side execution | Docker containers (§4) |
| Agent tools | Module-specific actions for the practice agent | Line annotations (§6) |
| Trace contribution | What the module adds to the learner's trace | Code snapshots, run results (§6) |
| Doctrine section | Prompt fragments in `prompts/workspace-<id>/`, composed whenever the module is available (the agent needs them to decide to pose one) | Owner-authored |

The practice gate (`createPracticeGate` / `activeProblemOf`), `conclude`, dismissals, recovery and outcome projection stay shared.

## 4. Runner: Docker

**(ruled: containers.)** Every run happens in a Docker container.

- **Docker is required for coding problems.** When Docker is missing or not running, the app refuses explicitly ("Docker isn't running") — the same refuse-don't-guess policy as missing credentials. No fallback to unsandboxed local execution.
- **Images per language, pulled on demand** at first use, with visible progress. Official base images (node, python, dotnet/sdk, eclipse-temurin, golang, rust, gcc), extended with the test framework and language server for each. First builds are large (roughly 1 GB for .NET, 1.5 GB for Rust). **(ruled)** The app builds these images locally from Dockerfiles shipped in the repo, pinned with the code; no registry. Publishing prebuilt images from CI stays a later option if first-build time hurts.
- **One warm container per active problem.** Started at pose time; runs execute inside it (`docker exec`), so a Run after the first is sub-second. Torn down at conclude/dismiss and on app exit; orphans are reaped at startup.
- **Lockdown:** `--network none`, non-root user, read-only root filesystem with a writable scratch volume holding the workspace files. **Limits (ruled):** 60 s per build, 10 s per test run, 1 GB memory, 2 CPUs, 256 processes; output capped at 64 KB shown to the learner, of which 8 KB goes to the agent.
- **Languages: all seven at once (ruled):** JavaScript, TypeScript, Python, C#, Java, Go, Rust, C++ (C# and Java listed together, as are Go/Rust/C++).

## 5. Problems and tests

**(ruled.)** The agent writes tests in each language's usual framework **(ruled)**: JS/TS `node:test` (TypeScript run directly by Node), Python pytest, C# xUnit, Java JUnit 5, Go `go test`, Rust `cargo test`, C++ doctest.

A coding pose commits, together:

- **Starter files** — what the learner sees (multi-file **(ruled)**).
- **Visible tests** — runnable by the learner on Run.
- **Hidden tests** — run on Submit.
- **Reference solution** — the module's form of the committed model solution.

**Pose-time verification.** Before the pose succeeds, the server runs every test against the reference solution in the container and builds the starter code. Any failure refuses the pose with the errors, so the model corrects and re-poses — the existing invalid-pose path, and the "verify, never one-shot" rule the demo builder follows.

- **Run** — builds and runs visible tests plus any scratch entry point; output and results stream into the workspace.
- **Submit** — runs all tests. Hidden test *contents* stay hidden until conclusion; only counts and pass/fail are shown.
- **Conclude** reveals the reference solution and all tests.

**Outcome fields (ruled).** Coding conclusions add mechanical fields computed by the app from the trace, never authored by the agent: tests passed / total (visible and hidden) at the last Submit, time to solve, and the count of asks and hints. `outcome` and `verdict` are unchanged; any judgment of the narration goes in the verdict text, with no score.

**Language choice (ruled):** a default language in settings, overridable per request ("…in Rust"). The agent poses in the requested language, else the default.

## 6. The learner trace and the listening agent

### The trace

Narration, code and runs fold into one timestamped trace per problem:

- **Narration** — committed dictation utterances, timestamped.
- **Code snapshots** — at each run, submit, ask, and listening update (diffs against the last snapshot sent to the agent, to keep context small).
- **Run/submit results** — build errors, test results, truncated output.
- **Asks** — direct requests to the agent (below).

Today's thinking submissions (`{ type: "thinking", problemCallId, text }` in `src/core/input-events.ts`) are the precedent: the trace generalizes them into structured, labeled messages the practice agent reads.

### Dictation

**(ruled: optional toggle.)** Dictation is a button/hotkey toggle in the workspace; it is never required. While on, it writes to the narration strip — the dictation target (`useDictationTarget`, `components/dictation.tsx:207`) is the strip, not the editor, so typing code and speaking don't collide. Long runs (15+ minutes) need a soak test on both dictation engines before this is relied on.

### Asking the agent

**(ruled: Ask button / hotkey.)** Pressing Ask makes the next spoken or typed text a direct request; it starts a turn immediately with the trace since the agent last saw it.

### Listening

**(ruled: listens by default; global opt-out in settings.)** With listening on, these cues send the agent a trace update **(ruled: all four)**:

| Cue | Proposed default |
|---|---|
| Each Run | immediately (subject to the cap) |
| Long silence | 90 s with no speech and no edits |
| Fixed interval | every 5 min of active work |
| Spoken struggle cue | phrase matching on committed narration ("I'm stuck", "I don't know why", "this isn't working", …) — cheap and local; a small-model classifier only if matching proves too noisy |

**Cap (proposed):** at most one update in flight; cues arriving meanwhile coalesce into the next one; at least 60 s between listening updates. Ask and Submit bypass the cap.

**Silent turns — new mechanism.** Every delivered update starts a turn, and today every turn ends in a visible reply. A listening agent must be able to look and say nothing. **(ruled)** An explicit `stay_quiet` tool — never inferred from an empty reply, so a failed or blank generation can't pass as silence. The turn is persisted for the agent's context and shows in the transcript as a faint, collapsed "agent looked · nothing to add" line.

Delivery uses the existing wake path (`src/server/jobs.ts` idle wakes / live steering), not a new channel.

### Line annotations

**(ruled: annotate, never edit.)** The agent can attach a comment or highlight to a file range ("look at this loop bound"). It cannot change the learner's code. **(ruled)** An annotation moves with its code as the learner edits around it. If the lines it was attached to are deleted, it is marked outdated and moved to a short "outdated" list, not deleted.

## 7. The workspace UI

**(ruled: split view.)** While a coding problem is active, the session splits: transcript (statement, agent nudges, conversation) on one side; workspace on the other, resizable.

The workspace holds a file tree, the editor, a run/test output panel, the narration strip with the dictation toggle, and Run / Submit / Ask.

**Editor (ruled): CodeMirror 6**, with **errors and warnings only (ruled)** from language servers — no autocomplete, hover, signature help or code actions. Language servers (tsserver, pyright, a C# server, jdtls, gopls, rust-analyzer, clangd) run inside the problem's container; their diagnostics relay over a server-side stdio ↔ browser bridge. The client advertises only diagnostic capabilities.

**Persistence (ruled):** the workspace — files, open tabs, narration — comes back exactly as left across reload and restart.

**Storage (ruled):** live files autosave to a separate per-problem store under `data/workspaces/`. The chat record receives only snapshots or diffs at trace events (run, submit, ask, listening update), so keystroke-rate saves never rewrite the chat file and the record stays the agent's source of truth.

**Naming (ruled):** in code, `workspace` and `WorkspaceModule`. The learner sees no generic umbrella name — only "Coding". "Laboratory" is dropped.

## 8. Graph and evidence

**(ruled: yes.)** Coding problems tag graph propositions like any practice problem (`target`), and outcomes stay session evidence, as today. Practice still skips extraction. The trace is the richer evidence the conclusion verdict draws on.

## 8a. Settings

A **Coding** section of its own in Settings (not a row in the Tools list, whose toggles filter the teaching registry only — `architecture.md` §3):

| Setting | Notes |
|---|---|
| **Default language** | **(ruled)** Used when a request doesn't name one. |
| **Agent listening** | **(ruled)** The global opt-out for §6 listening. On by default. |
| **Docker status** | Read-only: running or not, which language images are downloaded (with size), and a way to download or remove them. |


**No separate enable switch (ruled).** Availability follows Docker: if Docker isn't installed, coding is removed from the agents' tools so they never try; if it's installed but not running, a coding pose is refused with a clear "start Docker" message. The teacher's Tools toggle (§8b) still applies to the teacher.

## 8b. The teacher can use it too

**(ruled: the teacher may prompt coding exercises.)** A lesson can pose a coding exercise mid-teaching, using the same coding module (runner, editor, tests, trace). That makes it a **teaching tool** as well, so it gets a row in the Tools list (e.g. "Tool · coding"), filtered from the teacher's registry like research/demo/visual/pdf. The practice side is unaffected by that toggle.

**(ruled)** The exercise opens **inside the lesson**: the split view opens in the teaching session with the same coding module. Its result returns to the teacher like a quiz answer — test results plus a summary of the trace. Listening follows the global setting.

## 9. Proposed build order

Each step ends green (`tsc`, tests, build) and browser-verified.

1. **Seam** — workspace descriptor on `problem`, module registry, dock switch; the thinking field becomes the default module. No behavior change.
2. **Runner** — Docker detection and refusal, per-language images, warm container lifecycle, lockdown, run/test execution, pose-time verification. All seven languages.
3. **Editor + workspace UI** — split view, CodeMirror, multi-file, output panel, persistence.
4. **Language servers** — diagnostics relay, per-language servers in the images.
5. **Trace + Ask** — narration strip, snapshots, trace messages, Ask.
6. **Listening** — cues, cap, silent turns, global setting.
7. **Annotations** — agent tool and editor rendering.
8. **Settings** — the Coding section (§8a); its pieces can land alongside the steps they configure.
9. **Teacher exercises** — the teaching tool, its toggle, inline split view and quiz-style result (§8b).
10. **Doctrine** — owner-authored interview-style and coding sections, plus the teacher's exercise guidance (can be drafted in parallel at any point).

## 10. Rulings on the former open questions (2026-11-01)

All ten were ruled at the recommended defaults; each is written into its section above.

| # | Question | Ruling | Where |
|---|---|---|---|
| 1 | Image source | Built locally from Dockerfiles in the repo, on official bases | §4 |
| 2 | Test frameworks | node:test, pytest, xUnit, JUnit 5, go test, cargo test, doctest | §5 |
| 3 | Silent turns | Explicit `stay_quiet` tool; faint collapsed "agent looked" line | §6 |
| 4 | Annotation lifetime | Moves with its code; marked outdated when its lines are deleted | §6 |
| 5 | Workspace storage | Per-problem store under `data/workspaces/`; snapshots in the record | §7 |
| 6 | Interview outcomes | App-computed tests passed, time, asks/hints; verdict unchanged | §5 |
| 7 | Limits | 60 s build, 10 s tests, 1 GB, 2 CPUs, 256 pids, 64 KB / 8 KB output | §4 |
| 8 | Naming | `workspace` / `WorkspaceModule` in code; learner sees "Coding" | §7 |
| 9 | Enable switch | None — availability follows Docker installed / running | §8a |
| 10 | Teacher exercises | Inline in the lesson; result returns like a quiz answer | §8b |
