# Fork rebuild on upstream v0.6.1 — plan

Rebuild the fork as a small feature stack on top of `upstream/main`, with
features living in plugins so future upstream syncs are a cheap rebase.

- Branch `fork-stack` (worktree `../learn-harness-merge`), based on
  `upstream/main` @ cb25c8e.
- Old fork history preserved at local tag `fork-main-pre-rewrite` (81b5537).
  Old `main` stays the daily driver until the stack replaces it.
- Replacing `origin/main` (force-push) happens only at the end, with explicit
  owner confirmation at that time.

## Decisions (owner-approved)

| Decision | Choice |
|---|---|
| History shape | Fresh stack on upstream/main; one (or a few) commits per feature. Future syncs = rebase the stack (git rerere). |
| Stack form | Features enter the stack only in final plugin form. No interim host versions. |
| Non-pluginable features | Isolated host commits at the top of the stack: new files + thin call sites. |
| Coding workspaces | Upstream `coding-questions` owns teacher exercises + Submit. Fork plugin adds Docker runner, LSP, pane, Run, Ask, listening, annotations, Settings → Coding. |
| Graphite | Colours → custom theme JSON. CSS/fonts → style-only plugin reading upstream tokens. Breadcrumb/resume cards/hero → isolated host commit. |
| Learner Mermaid | Sibling plugin (no edits to rich-code-blocks). |
| Plugin packaging | Core plugins: `plugins/<id>/` + one line each in `core-plugins.json`. |
| Execution | Build all extension points first (designs owner-approved), then subagents implement each feature plugin. |

## Feature → target form

| Feature | Target | Needs extension points |
|---|---|---|
| Learner Mermaid diagrams | plugin | E6 learner-field accessory |
| Graphite colours + CSS/fonts | theme JSON + style plugin | (E8 stable hooks, optional) |
| Readings + overview + Discuss | plugin | E1 markers, E2 side panel, E5 selection/plan-node action context |
| Coding workspaces | plugin | E1, E2, E3 plugin steer/turn, E7 hide turn text |
| Deep dive from practice | plugin | E4 seeded session create, E5 graph/chains selection context |
| Local + phone dictation | host commit | — |
| Remote control / PWA | host commit | — |
| Graphite breadcrumb/resume cards/hero | host commit | — |
| Auto-updater → fork releases | host commit (config) | — |
| Interview mode (branch `interview-mode`, 9 commits, never in main) | plugin (owner 2026-11-12) | audit after the other features |

## Extension points (generic, designed to be upstreamable)

| Id | Extension point | Unblocks |
|---|---|---|
| E1 | Plugin transcript markers: namespaced customType, frontend renderer, backend append | readings, coding |
| E2 | Session side-panel slot beside the transcript | readings, coding |
| E3 | Backend steer / start-turn into a native session | coding |
| E4 | Create a seeded native session | deep dive |
| E5 | Richer action contexts: transcript selection, plan node, graph/chains selection | readings, deep dive |
| E6 | Learner-field accessory with read/write handle | mermaid |
| E7 | Plugin tool may hide its turn's assistant text | coding |
| E8 | Stable theme tokens / `data-lh-*` hooks (optional) | graphite |

Each extension point is designed with the owner before it is built
(API shape, naming, scope), one commit each, at the bottom of the stack.

## Proposed order (each step: design Qs → build → gates green → commit)

1. Graphite theme JSON + style plugin (no extension points; proves the
   fork-plugin packaging path).
2. Mermaid: E6, then the plugin.
3. Deep dive: E4, E5 (graph/chains part), then the plugin.
4. Readings: E1, E2, E5 (transcript/plan part), then the plugin.
5. Coding: E3, E7, then the plugin on top of coding-questions.
6. Host commits: auto-updater, Graphite slots, dictation, remote control.
7. Replace `origin/main` (owner confirms force-push).

## Open questions (asked before the step that needs them)

- Plugin ids / naming.
- Per extension point: API shape.
- Coding: existing saved workspace data — migrate or drop?
- Readings: remote images now blocked upstream (ef0075f) — acceptable?
- Deep dive vs upstream side companion: keep both entry points?
- When does `fork-stack` replace `main` — after all steps, or earlier?
