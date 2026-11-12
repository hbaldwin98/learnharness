# Coding workspaces

A fork Core plugin that adds a Docker sandbox and a working environment on top of
upstream's **Coding questions** plugin (`coding-questions`). Coding questions still owns
the teacher's `coding_question`, the practice `coding_problem`, the editor and Submit.
This plugin adds:

- **Sandboxed execution.** It registers with coding-questions' runner hook, so grading and
  practice submissions run the teacher's test recipe in a locked-down container: no
  network, read-only root, tmpfs `/work`, uid 1000, 2 GiB memory, 2 CPUs, 256 processes,
  no capabilities. The 30-second and 64 KiB-per-stream limits are the same as local runs.
  When Docker is missing or stopped, the language has no image, or the sandbox fails,
  coding-questions runs the tests locally and the result shows
  "Tests ran locally (no sandbox): …".
- **Run.** A Run button in the editor header and in the pane runs the item's tests in the
  sandbox. It is not graded and does not submit or conclude. Run needs Docker.
- **Language-server diagnostics.** typescript-language-server, basedpyright, csharp-ls,
  jdtls, gopls, rust-analyzer and clangd run in the item's container. Their errors and
  warnings go to the editor through coding-questions' editor hook. The server never sees
  the teacher's tests.
- **Workspace pane.** This is a session side panel titled "Coding". It shows the status,
  Run, recent Runs, a narration strip (typed, or dictated with the host dictation
  widget), Ask, and the tutor's notes.
- **Ask.** Sends the strip's draft plus the trace since the tutor last looked, as a
  learner-triggered steer. The trace holds narration, Run results, a line diff of the
  code and the current editor problems.
- **Listening.** The tutor looks in after a Run, after 90 s of quiet, every 5 minutes of
  activity, and when the narration sounds stuck. These looks are background steers, at
  most one a minute, and only while an editor is visible. The tutor answers with
  `stay_quiet` unless it can help right now. Turn listening off in
  **Settings → Coding workspaces**.
- **Annotations.** The `annotate` tool pins a note to lines of the learner's current code.
  The note follows its lines as the learner edits, and becomes outdated when those lines
  are deleted. Notes show in the editor and the pane.
- **Submission trace.** When coding-questions grades a submission in the sandbox, the
  trace since the last look is added beside it for the tutor (a plugin marker).
- **Shortcuts.** Run tests (`mod+'`), Ask (`mod+;`, sends the work without words), and open
  the pane (unbound by default).

## Images

Each runtime has its own image directory under `docker/`. An image is built locally on
first use and tagged `learnharness-code-<dir>:<hash>`. A changed directory rebuilds the
image and deletes the superseded tag. Images are kept until you remove them in Settings.
The first build of a language takes several minutes and makes that first Run or Submit
slow. Containers are reaped after 30 minutes idle, and on plugin activation and
deactivation.

## Development

```sh
npm run plugins:setup          # from the app root
npm run typecheck && npm test  # in this folder
npm run test:docker            # opt-in: needs a running Docker engine
npm run build
```

Old coding-workspace data from the pre-rewrite fork is not migrated.
