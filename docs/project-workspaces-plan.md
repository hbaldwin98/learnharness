# Project workspaces — design & plan (approved 2026-11-16; implemented)

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

- Step 1: the plugin API has no folder picker or "open path", so a custom folder is typed as an absolute path and the pane offers "Copy path" in place of "Open in IDE".
- Step 1: removing a managed project asks twice (delete files? then confirm); custom folders are only forgotten.
- Step 1: creating a project from the pane attaches it to the current session immediately.

- Step 2: the project container keeps a read-only root, no-new-privileges and the memory/CPU caps, but not CapDrop ALL (a root `chown` hands the fresh HOME volume to the learner's user). It runs as uid 1000, or as the host uid on Linux so files in the bind mount stay owned by the learner.
- Step 2: Run is limited to 5 minutes and 256 KiB per stream. A timed-out or stopped run restarts the container. The last 10 runs are kept per project.
- Step 3: snapshots use the host's git (no git means no snapshots or diffs, and nothing else changes). The project gets no automatic "looks" after a Run. The tutor sees changes via Ask, `project_changes` and task submissions.
- Step 4: `project_run` runs are recorded like the learner's own runs, so the learner sees them.
- Step 5: a proposal can be exact replacements or full content (new files included). Accepting a proposal for a file that changed since is refused as stale. The outcome goes to the proposing chat as a marker.
- Step 7: there is one shell per project (sessions on the same project share it), with a 128 KiB backlog. xterm.js 5.5.0 and addon-fit 0.10.0 are bundled, with their CSS and license.
- Step 8: project tasks are a practice problem type, because the host offers problem types to practice agents only. Teaching sessions check work with `project_run`. Hidden tests go to `/tmp/lh-task` (`$LH_TESTS`), never into the folder.
- Step 9: diagnostics are checked on demand (a tool and a pane button), not on every keystroke, since you edit in your own IDE. A check covers up to 200 source files of 256 KiB each, and the server state lives under HOME.
- Step 10: the tutor's `project_suggest` holds one pending suggestion per chat until the learner creates or dismisses it.

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
