# omp-session-bus

Project-scoped local messaging between **independent top-level omp sessions in separate terminals**. Subagent messaging (`task`, `agent://`, IRC, and Agent Hub) is unchanged. No server, credentials, TCP listener, or remote service is required.

Version 2.1.0 uses omp's standard extension API and native secure IPC. Dependencies remain pinned to **omp 18.17.0**; additional host verification is reported separately, not inferred from installation.

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

The receiving runtime acknowledges acceptance. One notification wakes the recipient for all unread requests and formal results, including final replies. The model reads the stable `session_inbox` batch, handles each exact pending request through `session_reply`, then completes the batch. No human forwarding or built-in `wait` is needed. Ordinary assistant text is not forwarded: exact reply correlation keeps unrelated user work and conversations separate.

## Commands and tools

| Terminal command | Behavior |
| --- | --- |
| `/session-id` | Show this live main session's address. |
| `/session-list` | Show the project, reachable main sessions, status, working directories, and local conversations. |
| `/session-inbox` | Inspect unread/active-batch state without consuming messages or starting a model. |
| `/session-send <id> [--turns N] <text>` | Start a conversation; report runtime acceptance and its conversation ID. |
| `/session-reply <message-id> [--done] <text>` | Send a correlated formal response; `--done` ends dialogue after delivery. |
| `/session-stop <conversation-id\|all> [reason]` | Cancel one or all local conversations without requesting a model turn. |

| Model tool | Behavior |
| --- | --- |
| `session_identity({})` | Return the live main session's identity and project. |
| `session_list({})` | Return self, peers, conversations, formal pending replies and separate inbox status. |
| `session_inbox({action:"read", batchId?, offset?})` | Claim/read the stable current batch; follow `nextOffset` with its exact `batchId` until all pages are read. |
| `session_inbox({action:"complete", batchId})` | Finish that batch only after every page is read and every still-pending request is replied to or cancelled. |
| `session_send({to, text, maxTurns?})` | Start a new same-project conversation. Do not create reminder conversations for an existing unresolved work item. |
| `session_reply({replyTo, text, done?})` | Answer an exact pending message; `done:true` places the final result in the recipient's batch inbox. |
| `session_stop({conversationId, reason?})` | Send terminal cancellation. |

These tools are excluded from child runtimes. Ordinary subagents and depth-zero `/tan` children publish no address and never enter the cross-session roster. `/agents` remains omp's built-in agent-definition manager.

For the first inbox read, omit `batchId` and `offset`: `session_inbox({action:"read"})`. An empty ID or `null` is not omission. Later pages use the exact returned `batchId` and `nextOffset`; completion takes the exact `batchId` and no `offset`. This tool opts out of structured-output strict rewriting so OpenAI-family hosts retain optional fields instead of requiring placeholder arguments. Runtime batch, page and pending-reply checks remain unchanged.

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
- Requests and substantive replies, including closed final results, enter one inbox. At most one owned wake marker waits in the host queue. Busy work is not interrupted; no global follow-up mode or grouping changes are made.
- Read all pages before deciding actions. Each entry preserves its original envelope and local receive sequence; arrivals after the batch high-water mark belong to the next batch. The active batch is stable on repeat reads. Completion schedules at most one next wake. No new wake is generated merely because a model stopped before completing a batch; inspect/read that active batch to resume.
- ACK and cancellation schedule no model turns. `done=true` closes dialogue, not unread-result handling. Closed results need no peer acknowledgment, routine per-message user report, reopened conversation or repeated business action.
- Responses require correlated project, conversation, message, sender, receiver, consecutive turn, and immutable budget fields. Concurrent conversations cannot consume one another's replies.
- The default budget is **8 substantive replies across both participants**, not 8 each. The allowed range is **1–64**. The last allowed response is terminal; models can finish earlier with `done: true`. Local result-processing turns and model API calls do not count as peer replies.
- Normal tool approval policies, costs, and interruption controls still apply. Peer input is attributed input, not privileged instructions, and must not override the receiver's user or system instructions. The extension does not bypass approvals or authorize a peer to act for the user.
- Session replacement/rewind cancels old conversations. Restarted runtimes get new random addresses; persisted transcript IDs are descriptive, not routable.
- `session_list.pending` only counts formal replies still owed. `inbox.unread` and `inbox.activeBatch` also cover final results. Listing is read-only; `session_inbox` explicitly claims and completes a batch. Manual replies and cancellation retire obsolete requests, never unread final results just because their conversation is closed.
- The inbox's single wake marker uses the existing queue-only admission callback and before-dequeue cancellation guard. User steering/follow-ups and abort-recovery identities remain untouched. A concrete local owning session is required; unsupported host handles fail initialization.
- An inbox holds at most 256 entries. Pages contain at most 32 entries and 1 MiB of encoded JSON, retaining complete messages without truncation. Overload rejects before advancing conversation state; duplicate replay and cancellation still work. Wake admission errors keep messages readable through `session_inbox` and do not automatically retry.
- Arrival sequence is not business revision. Compare explicit work item/object/candidate/operation identities and current evidence across conversations; no latest-arrival-wins or text-similarity deduplication is performed. A completed batch acknowledges handling, not exactly-once execution of arbitrary business effects. Preserve operation receipts and uncertainty on interruption.

### Upgrade and recovery

Version 2.1.0 needs both peers restarted after their installed source link is updated. Already-running windows keep the old handler and old queued text; the new inbox does not retroactively claim those notifications. Before restarting, finish or record pending work and stop sending reminders for closed work. Do not clear all host queues: user input and abort recovery are separate. After restarting, obtain new live addresses with `/session-list`.

If an inbox wake was interrupted, `/session-inbox` shows the outstanding batch. Resume with `session_inbox({action:"read"})`, read every returned page, answer/cancel exact pending requests, then complete the returned batch ID. Terminal results are consumed only by completion, not by their conversation closing. Cross-restart mailbox recovery and automatic business-state supersession are not implemented.

### Batch verification

Windows with the pinned 18.17.0 SDK: type checking passed; 123 tests passed, 5 POSIX-only skips, 0 failures. After the review's compact-serialization correction, type checking and the actual IPC/tool serialization test passed separately. Installed 18.20.0 SDK: 88 queue/inbox/conversation/IPC tests and type checking passed. These are distinct runs, not a new whole-suite result on every version.

An isolated compiled omp 18.20.0 CLI run used a deterministic local provider (no remote model call), actual extension registration, AgentSession, native IPC and real model tool execution. Twenty final results plus one request produced one inbox wake and one batch, consumed all 21 original envelopes, returned the exact correlated reply and left zero unread entries. The fixture's early incomplete runs are not counted as passing. This verifies the runtime mechanism, not arbitrary model obedience or business-effect exactly-once behavior. Linux/macOS were not rerun for this release.


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
