# Coding workspace images

One image per runtime for the practice coding module (`docs/practice-workspaces.md`, plan step 2). The app builds them locally on first use, tagged `learnharness-code-<dir>:<hash of the directory>`; a changed directory rebuilds and the superseded image is deleted.

Conventions every image follows:

- `LABEL learnharness.workspace=code`.
- `/opt/scaffold/` holds the app-owned project files, copied into each run directory before the agent's files.
- `/opt/lh/` holds runtime helpers (test runners, headers); world-readable.
- Caches and `HOME` point into `/work`, the container's tmpfs; the root filesystem is read-only at run time and the container runs as uid 1000 with no network.
