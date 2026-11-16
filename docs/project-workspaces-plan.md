# Project workspaces — design & plan (draft, awaiting approval)

Long-lived, persisted coding projects that a teaching session builds on, extending the
fork's `coding-workspaces` plugin. Fork-only: new code goes in new files under
`plugins/coding-workspaces/src/` to minimize upstream conflicts.

## Decisions (from user, 2026-11-16)

| Topic | Decision |
|---|---|
| Storage | Host folder bind-mounted into the container at `/work` |
| Location | Default `<learning data>/core-plugin-data/coding-workspaces/projects/<id>/`, optional user-chosen folder per workspace |
| Scope | Independent named workspaces; a session attaches to one; several sessions can continue the same workspace |
| Editing | User edits in their own IDE; app shows read-only file tree + viewer |
| Tutor access | Read files, run commands; file changes only as proposed diffs the user accepts/rejects |
| Network | On for workspace containers; installs persist (in folder or per-workspace cache volume). CPU/mem/non-root limits kept |
| Running | In-app terminal attached to the container + configurable per-workspace Run command (output visible to tutor) |
| Exercises | New project-task mode: tutor sets a task, Submit runs tutor tests against the whole workspace in its container. Single-file questions unchanged |
| History | Folder is a git repo; app snapshots on Run/Submit/Ask to a hidden ref (`refs/learnharness/snapshots/*`), tutor sees diff since last look |
| Creation | User creates/attaches from pane; tutor may propose via tool, user confirms. Attaching existing workspace to a session is user-only |
| Image | Existing per-language images (node, python, go, rust, dotnet, java, cpp); changeable later |

## Minor decisions (recommended defaults taken)

- Container lifecycle: one container per workspace, started on demand, stopped after 30 min idle; files persist regardless.
- Package caches: per-workspace Docker volume mounted at the language cache dir (e.g. `~/.npm`, `~/.cache/pip`, `~/.cargo/registry`).
- Listening triggers: existing triggers, plus a debounced host file-watch replacing editor-buffer activity.
- Unattached workspaces are never deleted automatically; delete is an explicit pane action (folder removal asks twice; user-chosen folders are only detached, never deleted).

## Components

1. **Workspace registry** (`server/projects.ts`): `{ id, name, language, hostPath, managed, runCommand, createdAt }` in plugin data; session→workspace attachment map.
2. **Project container** (`server/project-container.ts`): long-lived container per workspace, bind mount + cache volume, network on, same resource caps; start/stop/reap.
3. **Git snapshots** (`server/snapshots.ts`): init repo if missing; snapshot to hidden ref without touching index/branches; diff since tutor's last look.
4. **Tutor tools**: `workspace_list_files`, `workspace_read_file`, `workspace_run` (command in container, bounded output), `workspace_propose_edit` (diff → user accept/reject), `workspace_propose_create`.
5. **Terminal**: PTY via `docker exec` streamed to an xterm.js view in the pane.
6. **Pane UI**: create/attach/detach, read-only file tree + viewer, "Open in IDE" (reveal folder), Run + recent runs, terminal, pending proposed edits, existing narration/Ask/notes.
7. **Project tasks**: new problem type in coding-workspaces (not a change to coding-questions) whose tests run against `/work` in the workspace container; Submit = snapshot + run tests + trace to tutor.
8. **Annotations**: extend to `{file, lines}` targets, shown in the file viewer.
9. **LSP**: run language servers in the workspace container over the real project.

## Implementation steps (each committed when gates pass)

1. Registry + managed/custom folders + pane create/attach/detach.
2. Project container lifecycle + Run command.
3. Git snapshots + diff in tutor trace.
4. Tutor read/run tools.
5. Proposed edits flow.
6. File tree + viewer + file annotations.
7. Terminal.
8. Project tasks (grading).
9. LSP against the project.
10. Tutor create-proposal tool + docs/README.

## Open items to confirm before implementation

- None outstanding beyond plan approval.
