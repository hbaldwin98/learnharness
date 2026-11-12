# Coding workspace images

One image per runtime for the coding-workspaces sandbox. The plugin builds them locally on first use, tagged `learnharness-code-<dir>:<hash of the directory>`; a changed directory rebuilds and the superseded image is deleted. (The node image's scaffold `package.json` is stored as `scaffold-package.json`: Core packages may not ship files named `package.json`.)

Conventions every image follows:

- `LABEL learnharness.workspace=code`.
- `/opt/scaffold/` holds the app-owned project files, copied into each run directory before the agent's files.
- `/opt/lh/` holds runtime helpers (test runners, headers); world-readable.
- Caches and `HOME` point into `/work`, the container's tmpfs; the root filesystem is read-only at run time and the container runs as uid 1000 with no network.
