# Fork plugin extension points (E1–E7) — design draft

Status: APPROVED by owner 2026-11-12 (decisions at the end). Grounded in upstream v0.6.1
(`src/core/plugins.ts`, `plugin-ui.ts`, `plugin-view-context.ts`,
`src/server/plugin-host.ts`, `components/plugin-manager.ts`).

Conventions followed: `register*(def): () => void`; lowercase-hyphen ids;
invalid/duplicate defs throw; UI = `mount(container, props{signal}) → cleanup`;
additive under `apiVersion: 1`; one doc per feature in `docs/plugin-api/`.

## E1 — Plugin transcript markers
```ts
interface PluginMarkerInput { typeId: string; details: unknown /* JSON ≤64KB */;
  modelText?: string /* omitted ⇒ invisible to model */; idempotencyKey?: string }
// backend
markers: { append(chatId: string, m: PluginMarkerInput): Promise<{ messageId: string; chatId: string }> }
// frontend
registerMarkerRenderer(r: { typeId: string; mount(container, m: { details; messageId; sessionId; signal }) }): () => void
```
- One generic `"plugin-marker"` customType, `details: { pluginId, typeId, data }`.
- Idle: write-ahead append under the chat claim. Busy: queued, lands at run persist via jobs registry.
- view.ts: `case "plugin-marker"` → `data-plugin-marker`; model sees `[plugin <id>] modelText` only if set; classifier → neutral.
- Disabled/missing plugin: muted "Plugin content (<id>)" fallback.
- New: `src/core/plugin-markers.ts`, `src/server/plugin-markers.ts`, `components/plugin-marker.tsx`. Touch: native-messages (+20), view (+10), plugins (+12), plugin-host (+25), part renderer (+15).

## E2 — Session side panel
```ts
registerSessionPanel(p: { id; title; icon?; sessions?: ("teaching"|"practice")[];
  defaultWidth?; minWidth?; mount(container, ctx: { sessionId; kind; signal }) }): () => void
app.openSessionPanel(sessionId, panelId); app.closeSessionPanel(sessionId)
```
- Lives per session view; survives turns/streaming; aborts on leave/disable.
- Host owns layout, splitter, close button, width/open persistence (localStorage per session+panel).
- Top-bar placements may declare `opens: panelId`.
- New: `components/plugin-session-panel.tsx`, `src/core/plugin-panels.ts`. Touch: `components/session.ts` (+20).

## E3 — Backend steer / start turn (fork exception to contract §1)
```ts
turns: { steer(chatId, input: { displayText: string; modelText: string; details?: unknown;
  idempotencyKey: string; mode?: "steer-or-wake" | "steer-only" })
  : Promise<{ delivery: "steered" | "woke" | "queued" }> }
```
- Wraps `jobs.ts deliverJobResult` (live → steer, idle → wake, 409 retry, question wait, dedupe).
- Limits: recently-touched sessions only; not archived/deleted; 1 in-flight wake per (plugin, chat), ≤6 wakes/chat/hour/plugin; never during compaction; modelText ≤8KB, framed as plugin-originated; queued steers dropped on disable.
- New: `src/server/plugin-turns.ts`, `src/core/plugin-turns.ts`. Touch: jobs (+10), plugin-host (+15).

## E4 — Seeded native session
```ts
sessions: { create(spec: { kind; nodeIds?; title?; opening?: { displayText; modelText };
  start?: boolean; idempotencyKey? }): Promise<{ chatId }> }
app.createSession(spec, opts?: { open?: boolean }): Promise<string>
```
- Reuses the existing create route; nodeIds validated against the graph; plugin origin recorded.
- New: `src/server/plugin-sessions.ts`. Touch: chats route (+15), plugins (+10).

## E5 — Richer action contexts
New placements/contexts (existing `"graph"` unchanged):
- `transcript-selection` → `{ sessionId, kind, selection: { text ≤4KB, messageId, partIndex? } }` via host popover.
- `plan-node` → `{ sessionId, planNodeId, title }`.
- `graph-selection` (graph + Chains) → `{ nodeIds, chainIds }`.
- New: `components/plugin-selection-popover.tsx`. Touch: plugins (+15), plugin-view-context (+20), plan / graph / chains components (+10 each).

## E6 — Learner-field accessory
```ts
registerFieldAccessory(a: { id; label; icon;
  fields?: ("composer"|"question-answer"|"practice-answer"|"thinking")[];
  run(field: PluginLearnerField) }): () => void
interface PluginLearnerField { kind; sessionId; read(): string; write(t): void; insert(t): void; signal }
```
- Writes go through the field's draft state; stale handles throw (contract §5.2 style).
- New: `components/plugin-field-accessory.tsx`, `src/core/plugin-fields.ts`. Touch: composer-actions, question-dock, practice-dock (+10 each).

## E7 — Tool hides its turn's assistant text
- `registerTools({ ..., hidesTurnText?: string[] })`; flag persisted into tool-result details.
- view.ts hides assistant text when a listed tool call succeeded (presentation only; model context unchanged). Port of fork `quietLooksOf`.
- Touch: view (+25), plugins (+3), plugin-host (+10).

## Build order
E6 → (Mermaid) · E5 graph-selection, E4 → (deep dive) · E1, E2, E5 transcript/plan → (readings) · E3, E7 → (coding).

## Owner decisions
- E1: optional `modelText` (host-prefixed); one generic `plugin-marker` customType (minor, recommended).
- E2: one panel open at a time; tabs when several plugins register.
- E3: safety limits as listed; wakes are `background` purpose unless learner-click-triggered.
- E4: frontend `app.createSession` only (no backend `sessions.create` in v1).
- E7: hide same-message text and the following text-only message.
- Old coding-workspace data: drop.
- Old readings data: migrate (store → plugin data dir; markers → `plugin-marker`).
- E3 details: steer stored as an E1 plugin-marker (modelText to tutor, displayText in details); `steer()` takes `trigger: "learner" | "background"` (learner → interactive purpose); "recently touched" = opened or updated within 30 min; `steer-only` with no live run rejects.
- E4 details: opening stored as an E1 plugin-marker; `start: true` always starts the first turn server-side; plugin origin only in that marker's details; `idempotencyKey` scoped per plugin, permanent.
- E5 details: `graph-selection` = Chains toolbar button (pick mode → ticked nodes in tick order, browse → all shown; chainIds = chains containing them) and graph node card (that node). `plan-node` deferred until a feature needs it.
- Builder minor choices accepted: E5 context `surface: "transcript"`; E1 busy-turn markers land at turn settle; marker cards on learner side; panel right, 360/240px, max 70%; >4KB selection → disabled "Shorten selection"; E6 buttons before paperclip / before Submit.
- E8 learner-text fences (added 2026-11-12 for Mermaid): learner answer/thinking text stays plain, but ``` fenced blocks render through the host code-block registry (built-in mermaid + plugin `registerCodeBlock`). Port of fork `learner-text.tsx`; applies in thinking-block, answered-card and the other learner-text displays the old fork covered.
- E6 extensions (added for Mermaid): `run(field, { anchor: HTMLElement })` so menus can anchor to the button; optional `preview?: { mount(container, field) }` slot rendered under the field (plugin debounces); optional `onKeyDown?(event, field): boolean` (true = handled) for Enter-inside-fence; `field.setCaret(offset)` for post-insert caret placement.
- E9 plugin themes (added for Graphite): a plugin manifest may list theme JSON files (validated by the host theme validator); the host offers them in Settings → Appearance alongside presets and custom themes, read-only, removed when the plugin is disabled.
- Graphite minor calls accepted: not added to the authoring projects list; docs' "four Core plugins" left untouched; global `.uppercase` sentence-case override kept.
- Coding (2026-11-12): add small hooks to plugins/coding-questions, designed to be proposed upstream — a backend runner hook (coding-workspaces runs tests in Docker) and an editor hook (toolbar slot, setDiagnostics, code read/change events). No Docker → fall back to the local runner with a visible "ran locally" notice. Run = visible tests in Docker, no grading/conclude; Submit stays the graded run.
- Deep dive (2026-11-12): part of the readings plugin with the old behaviour (node reading, not a session). Host commit: Home/new-session persist their draft across navigation.
- Dictation (2026-11-12): live {read, write} targets for core fields; plugin + side-thread destinations keep upstream's append contract; plugin dictation API unchanged.
- Readings old `reading-discussion` markers: one-time fork migration script (backup, idempotent, --dry-run), no host hook.
- Interview mode: plugin-owned (not native sessions). Interviewer model = plugin setting via model picker (default cheap slot, lowest thinking); bundles its own CodeMirror; "Teach me the gaps" via E4; old interview data dropped; multiple-choice as plugin UI; replay harness kept as plugin script/test; Live screen is a full plugin view; own CSS.
- E10 (added for interview): plugin dictation `onCommit(text, at)` — fires per committed chunk with a timestamp, for pause detection.
- E6 addition (Mermaid follow-up, minor): `field.caret()` getter returning the caret offset in source text.
- Coding follow-ups (2026-11-12): propose the coding-questions runner + editor hooks upstream as they are (global-symbol registries; no host service registry first). Run results go to the trace only, never into grading. A language with no sandbox image falls back to the local runner with the notice (minor, accepted). Coding doctrine prompt text: still the owner's to rewrite.
- Live check fixes (2026-11-13): fork plugins (graphite, learner-mermaid, readings, coding-workspaces, interview) start ENABLED on fresh installs (upstream Core plugins keep upstream's default; an explicit user disable is respected). E11 view state in the URL: a plugin view's state (e.g. readingId, interviewId) is reflected in the URL so refresh and Back/Forward restore it (minor API shape, builder's choice following existing view conventions). Graphite sentence-case covers dock labels and plugin view labels; plugin sidebar actions match native sidebar entry size.
- Mermaid prompt guidance lives entirely in the plugin, including practice "judge structure, not text".
- Upstreaming: propose E1, E2, E5, E6 later; E3 stays fork-only (minor, recommended).
