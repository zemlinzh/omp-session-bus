# omp-session-bus

Project-scoped local messaging between **independent top-level omp sessions in separate terminals**. Subagent messaging (`task`, `agent://`, IRC, and Agent Hub) is unchanged. No server, credentials, TCP listener, or remote service is required.

Version 2.0.1 uses omp's standard `registerTool`/`registerCommand` extension API and native secure IPC. The host peer dependencies are pinned to the tested **omp 18.17.0** versions; other host versions are not claimed compatible.

## Prerequisites and installation

- Bun **1.4.4 or newer** and omp **18.17.0**, available on `PATH`.
- Windows, macOS, or Linux with a native `@oh-my-pi/pi-natives` build supported by the host. Windows uses named pipes; macOS/Linux use Unix-domain sockets.
- Git on `PATH`, supporting `git rev-parse --path-format=absolute`. Git is also needed to determine that a directory is non-Git; an unpacked source archive does not need to be initialized as a repository.
- Local filesystem access to the discovery directory. Participating sessions must run as the same OS user and share its discovery base.

Obtain the source archive from whoever shared this project and extract it, or clone the **actual repository URL supplied by its owner**. No public remote is assumed. Open a terminal in the extracted or cloned `omp-session-bus` directory and run:

```sh
bun install --frozen-lockfile
omp install .
```

Keep that source directory in place: the local install links to it. Restart participating omp terminals after installation or upgrades. An explicit launch from the source directory is also possible:

```sh
omp --extension ./src/index.ts
```

The footer shows:

```text
session id: omp-<16 hex digits> | project: <project-name> | idle
```

### Migrating from omp-local-agents

The old package, command names, tool names, and environment variables are removed, not aliases. After obtaining this source at its new location, remove the old user-level source link and install the new one:

```sh
omp plugin uninstall omp-local-agents
bun install --frozen-lockfile
omp install .
```

Run the install commands from the new source directory. Remove old explicit `--extension` paths from launch scripts, replace old environment settings with `OMP_SESSION_BUS_DIR` and `OMP_SESSION_BUS_PROJECT_ROOT`, and **restart all participating terminals**. Existing processes retain their loaded implementation and live addresses; do not mix them with the upgraded sessions. Protocol v2 rejects unscoped/v1 peers. Copy fresh session IDs after restarting.

To uninstall this package:

```sh
omp plugin uninstall omp-session-bus
```

## Two-terminal workflow

1. Start omp in terminals A and B in the same repository or its linked worktrees.
2. In B, copy its footer address or use `/session-id`.
3. In A, use `/session-list` to find reachable sessions **in the current project only**.
4. Start a conversation:

```text
/session-send <B-session-id> Compare your design with mine and ask follow-up questions until we agree.
/session-send <B-session-id> --turns 4 Compare the alternatives and return your final recommendation.
```

The receiving runtime acknowledges acceptance. Its model explicitly sends a substantive response with `session_reply`. Formal responses automatically reach the sender for processing, **including a final response after the sender has become idle**. No human forwarding, receive tool, or built-in `wait` call is needed. Ordinary assistant text is not blindly forwarded: exact reply correlation keeps unrelated user work and concurrent conversations separate.

## Commands and tools

| Terminal command | Behavior |
| --- | --- |
| `/session-id` | Show this live main session's address. |
| `/session-list` | Show the project, reachable main sessions, status, working directories, and local conversations. |
| `/session-send <id> [--turns N] <text>` | Start a conversation; report runtime acceptance and its conversation ID. |
| `/session-reply <message-id> [--done] <text>` | Send a correlated formal response; `--done` ends dialogue after delivery. |
| `/session-stop <conversation-id\|all> [reason]` | Cancel one or all local conversations without requesting a model turn. |

| Model tool | Behavior |
| --- | --- |
| `session_identity({})` | Return the live main session's identity and project. |
| `session_list({})` | Return self, same-project peers, conversations, and messages needing formal replies. |
| `session_send({to, text, maxTurns?})` | Start a new same-project conversation. An ACK is not the formal answer. |
| `session_reply({replyTo, text, done?})` | Answer an exact pending message; `done: true` still wakes the recipient to process the final result. |
| `session_stop({conversationId, reason?})` | Send terminal cancellation. |

These tools are excluded from child runtimes. Ordinary subagents and depth-zero `/tan` children publish no address and never enter the cross-session roster. `/agents` remains omp's built-in agent-definition manager.

## Project isolation

The default project identity is the canonical **Git common directory**, not a directory prefix, branch, or remote URL. Nested directories and internal/external linked worktrees of one repository share a group. Different repositories and independent clones stay separate, even with identical remotes.

Each project has a discovery directory and native IPC namespace. Metadata, requests, replies, receipts, and conversation state must match the `projectId`; a known session ID cannot bypass cross-project rejection. Non-Git directories default to their canonical launch directory. Unexpected Git failures abort initialization rather than silently selecting an incorrect group. Bare repositories and Git paths containing newlines are unsupported.

### Logical subprojects

Set `OMP_SESSION_BUS_PROJECT_ROOT` before starting each terminal to isolate a logical subtree. Launch inside that subtree or a descendant (or select it with omp's `--cwd`). For example, from `apps/A` in a linked worktree:

```sh
# macOS/Linux
export OMP_SESSION_BUS_PROJECT_ROOT=apps/A
omp
```

```powershell
# Windows PowerShell
$env:OMP_SESSION_BUS_PROJECT_ROOT = "apps/A"
omp
```

Relative roots resolve against the Git worktree root, not a nested launch directory. The group key combines repository ownership and its logical repository-relative path. An absolute root in another linked worktree maps to the corresponding current-worktree path. Missing, escaping, wrong-repository, and non-containing roots are rejected. `apps/A`, `apps/B`, and the default whole-repository group remain isolated.

In a non-Git directory, an explicit ancestor root groups its descendants. Unset the variable to restore default grouping. Tools' individual `cwd` arguments do not move a session to another group. A project-changing session transition withdraws the old endpoint and assigns a new live ID; same-project transitions keep the ID but cancel old conversations.

## Delivery, approval, and termination

- ACK means the runtime accepted input, not that its model read or completed it.
- Requests and every substantive formal reply use supported follow-up delivery. Idle receivers start a processing turn; busy receivers queue a continuation behind existing work, without forcibly interrupting a tool or requiring another human prompt.
- ACK and cancellation schedule no model turns. `done=true` ends peer dialogue, **not local final-result processing**. The final recipient processes/reports the result without another peer response.
- Responses require correlated project, conversation, message, sender, receiver, consecutive turn, and immutable budget fields. Concurrent conversations cannot consume one another's replies.
- The default budget is **8 substantive replies across both participants**, not 8 each. The allowed range is **1–64**. The last allowed response is terminal; models can finish earlier with `done: true`. Local result-processing turns and model API calls do not count as peer replies.
- Normal tool approval policies, costs, and interruption controls still apply. Peer input is attributed input, not privileged instructions, and must not override the receiver's user or system instructions. The extension does not bypass approvals or authorize a peer to act for the user.
- Session replacement/rewind cancels old conversations. Restarted runtimes get new random addresses; persisted transcript IDs are descriptive, not routable.
- `session_list` is a read-only snapshot, not a second delivery channel. If an exact pending ID is answered through `session_reply` before automatic delivery, its still-queued actionable notification is withdrawn. Closing/stopping/failing a conversation also cancels its queued reply-required notifications; previously delivered history remains available and is not replayed as new work.
- Reply-required notifications use the pinned host's queue-only custom-message admission callback and before-dequeue guard. This preserves custom metadata and agent attribution while rechecking state after asynchronous preprocessing. The plugin needs its owning concrete local omp session; an unsupported remote/custom SDK session handle fails initialization rather than falling back to unsafe uncancellable delivery.

## Transport and trust

Each main runtime binds a native endpoint and atomically publishes metadata under:

```text
~/.omp/run/session-bus/<project-id>/<session-id>.json
```

`OMP_SESSION_BUS_DIR` overrides the discovery **base**. Sessions must share it to discover each other; sharing it does not merge project groups. Peers derive endpoints from the base and validated live IDs, never arbitrary metadata endpoints. Endpoint probes exclude stale crash files. Metadata contains neither message bodies nor authentication secrets.

Windows uses owner-only named pipes with remote clients rejected. Unix uses owner-verified local sockets, with native endpoint handling for long paths. The security boundary is the **current OS user**, not protection against malicious code running as that user. Project isolation is routing separation between cooperating sessions, not an OS sandbox. Delivery is local-machine only.

Limits include 128 KiB UTF-8 text, 256 KiB encoded frames, a 5-second transport deadline, bounded connections, 64 pending formal replies, 128 active conversations, and 256 recent closed-conversation tombstones. JSON escaping can exhaust the frame limit first. Exact recent duplicates do not create another model request; changed envelopes reusing an ID are rejected.

This is live-session delivery, not an offline mailbox or crash-recovery service. Delivery errors close the local conversation and are reported; there are no automatic retries or unlimited waiting loops. A lost ACK does not prove the receiver did nothing. Final delivery and receipt records are custom session entries governed by omp's normal persistence policy.

## Development and platform verification

From the source checkout:

```sh
bun install --frozen-lockfile
bun run check
bun test
```

The source retains deterministic tests for project grouping, real Git worktrees/clones, subprocess IPC, cross-project rejection, correlation/replay, finite turns, and cancellation races. Tests are development assets, not part of the published package's `files` list.

Credential-free CI runs frozen installation, TypeScript checking, and tests on Windows, Ubuntu, and macOS using Bun 1.4.4. CI does not publish packages or invoke authenticated model providers. A configured matrix is not evidence that a run has passed.

Initial 2.0.0 verification with omp 18.17.0 and Bun 1.4.4 (historical baseline):

- Windows x64: TypeScript checking passed; 61 tests passed, 5 POSIX-only tests skipped, 0 failed (578 assertions). Two actual omp processes executed all five model tools and exercised all five user commands, including manual and model formal replies, automatic final-result processing, and non-waking cancellation. The renamed user-level plugin auto-loaded in the real TUI.
- Linux x64/glibc: TypeScript checking and all 66 tests passed, 0 failed (636 assertions), in a private Linux container filesystem. Coverage includes real Unix socket delivery, permissions/ownership, unsafe-root and publication rejection, Unicode/long socket paths, subprocess shutdown, and project isolation. Two actual omp CLI processes also exposed all five model schemas and user commands and discovered one another without model credentials or API calls.
- macOS: no local macOS host was available. The subsequent [baseline GitHub CI run](https://github.com/zemlinzh/omp-session-bus/actions/runs/42271189543) completed successfully on macOS, Windows, and Ubuntu for commit `29d5e37`. This is baseline test evidence, not a claim of macOS real-model execution or passing 2.0.1 CI.

The Linux verification used a cached Debian-based Node image and the official Bun 1.4.4 npm binary because Docker Hub was inaccessible. Published native Linux dependencies were installed for Linux, not copied from Windows. The source package is portable; platform binaries are supplied by the pinned host dependencies.

### 2.0.1 queued-notification regressions

Local Windows verification: TypeScript checking passed; 83 tests passed, 5 POSIX-only tests skipped, 0 failed (1,253 assertions across four files). New coverage includes two manually consumed threads across 20 rounds, cancellation before/after admission, restored objects, lifecycle replacement, unrelated user-input recovery in both queues, and continuously visible retained user steering.

The native 2.0.0 mechanism was reproduced in two independent three-session runs: both conversations were closed and pending was empty, but four handled notifications remained queued and were later presented again. The patch withdraws still-pending/claimed notifications, not already committed model input or retained history. Restart all participating terminals after updating; loaded 2.0.0 handlers and their existing queues are not hot-patched.
