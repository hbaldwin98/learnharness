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

## Project workspaces

A project workspace is a long-lived folder on your machine that teaching and practice
sessions build on over time. Edit it in your own editor; the Coding pane's **Project**
section shows it, runs it and lets the tutor work with it.

- **Folders.** A project is either a managed folder under
  `<plugin data>/projects/<id>/` or an absolute folder you choose. A session attaches to
  one project, and several sessions can attach to the same project. Removing a managed
  project can delete its folder after you confirm twice. A folder you chose is never
  deleted.
- **Container.** Each project has one long-lived container built from its language image.
  The folder is bind-mounted at `/work`, and a per-project volume holds `HOME`
  (`/home/lh`), so package caches and tool state survive restarts. The network is on so
  you can install packages. The container keeps a read-only root, no-new-privileges,
  2 GiB of memory, 2 CPUs and 512 processes. It runs as uid 1000, or as your own uid on
  Linux. The container is removed after 30 minutes idle and recreated on demand.
- **Run and terminal.** Run executes the project's run command in `/work` (5 minutes,
  256 KiB of output per stream), with Stop. Recent runs are kept. The pane also has an
  interactive shell (xterm.js) in the container. Its recent output replays when you
  reopen it.
- **Snapshots.** The folder becomes a git repository with a starter `.gitignore` if it
  is not one already. Each Run, task submission and accepted change snapshots it to
  `refs/learnharness/snapshots/latest` through a temporary index. Your branches, index
  and working tree are never touched. The tutor sees what changed since its last look in
  each chat (`refs/learnharness/looks/*`). Snapshots need git on the PATH; without git,
  everything else still works.
- **Tutor tools** (teacher and practice):
  - `project_files` and `project_read` list and read files. Paths are confined to the
    folder.
  - `project_changes` shows the diff since the tutor's last look.
  - `project_problems` reports language-server errors across the project's source files.
  - `project_run` runs a command. You see every run.
  - `project_annotate` pins notes to lines of a file. A note follows its lines and goes
    outdated when they are deleted.
  - `project_propose_edit` proposes a change as a diff. Nothing is written until you
    accept it, and a proposal is refused as stale if you changed the file since.
  - `project_suggest` suggests creating a project. Nothing is created until you confirm.
- **Ask.** Sends your question, the changes since the tutor's last look and the latest
  run.
- **Project tasks** (practice). The `project_task` problem type poses a task you build in
  the project. Submit sends the project as it is on disk. The tests run in its container
  from `/work`, with any hidden test files in a temporary `$LH_TESTS` outside your
  folder. The results are observations: `conclude` still makes the assessment.
- **Problems.** "Check problems" runs the image's language server over the project, with
  its state kept under `HOME` and no config written into your folder. Click a problem to
  open its line in the viewer.

Project tasks are a practice problem type because the host offers problem types to
practice agents only. In teaching sessions, the tutor checks work with `project_run`.

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
