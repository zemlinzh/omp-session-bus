# Changelog

## 2.0.0

### Breaking changes

- Rename the package from `omp-local-agents` to `omp-session-bus`.
- Replace the old tool surface with `session_identity`, `session_list`, `session_send`, `session_reply`, and `session_stop`; remove old aliases.
- Replace terminal commands with `/session-id`, `/session-list`, `/session-send`, `/session-reply`, and `/session-stop`.
- Replace environment settings with `OMP_SESSION_BUS_DIR` and `OMP_SESSION_BUS_PROJECT_ROOT`; default discovery base is `~/.omp/run/session-bus`.
- Display `session id: omp-... | project: ...` in the footer. Live `omp-` IDs and project-scoped wire protocol v2 are retained.
- Migration requires uninstalling the old source link, installing the new source directory, and restarting every participating terminal. Old settings and loaded processes are not compatibility shims.

### Distribution

- MIT-licensed standalone source package using the standard `omp.extensions` entry point `./src/index.ts`.
- Bound host peer dependencies to the tested 18.17.0 versions and require Bun 1.4.4 or newer.
- Retain development tests; distribute source, README, license, and changelog.
- Add credential-free Windows, Ubuntu, and macOS CI for frozen installation, type checking, and tests. Matrix configuration does not imply verified platform results.

### Portability and verification

- Add real POSIX socket, private-permission, unsafe-root/publication, and long-Unicode-path behavior coverage while keeping Windows-only skips explicit.
- Improve subprocess stdin-EOF shutdown and fixture cleanup; retain cross-platform linked-worktree and Unicode logical-root tests.
- Verify this release on Windows x64 and Linux x64/glibc, including actual omp CLI/plugin surfaces; macOS native execution remains unverified pending a real host or CI run.

### Public tool parity

- Add `session_identity` and a user `/session-reply` command so every public model operation has a terminal counterpart.
- Allow `session_stop` to cancel all conversations with the same explicit reason supported by the user command.
- Use one implementation path for each model/user send, reply and cancellation operation; keep normal approval tiers and main-session-only scope.

### Preserved behavior

- Independent main sessions communicate only within their resolved project, including linked-worktree and optional logical-subproject grouping.
- Formal final responses automatically wake idle recipients for local result processing without a human prompt or built-in wait call.
- Subagents remain excluded; normal approval policies and native same-user IPC boundaries remain in force.
