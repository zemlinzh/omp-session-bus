# Changelog

## 2.1.0

### Fixed

- Replace per-message request and final-reply model wakeups with one owned inbox marker. The current unread backlog is claimed as a stable receive-sequence batch; arrivals during processing form the next batch.
- Add `session_inbox` read/complete with exact batch IDs, bounded complete-body pages, and completion guards for unread pages or unanswered requests. Expose unread/final-result state separately from conversation pending replies.
- Preserve every original correlation envelope and final result. Batch guidance reconciles business revisions before actions; it never treats arrival order as version order or silently deduplicates similar topics.
- Keep cancellation and manual consumption bound to the exact marker, without changing host follow-up modes, user input, recovery objects or delivered history. Wake-admission failures retain readable messages and report an explicit recovery path, not a retry loop.
- Preserve optional inbox IDs and offsets in model-facing schemas through a tool-local strict-mode opt-out; keep exact batch, page and pending-reply guards unchanged.

Existing terminals retain old handlers and notifications until restarted. This release is not a hot patch or cross-restart mailbox; finish or record outstanding work before restarting both peers.

## 2.0.1

### Fixed

- Withdraw reply-required notifications that were already answered through `session_list` / `session_reply`, stopped, failed, or invalidated by a session/project transition. They no longer remain as delayed actionable follow-ups after discussion completion ([#1](https://github.com/zemlinzh/omp-session-bus/issues/1)).
- Revalidate asynchronous custom-message admission and prune restored stale queued objects without changing peer attribution or erasing delivered history.
- Remove only owned pending/claimed objects with recovery-preserving queue pop/re-enqueue operations. Unrelated user input in either queue keeps its order and abort-restoration state.
- Keep genuine unhandled messages and final-result processing automatic. Existing terminals must restart to replace their loaded 2.0.0 handlers.

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
