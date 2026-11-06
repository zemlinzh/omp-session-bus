import { IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { LocalPeer } from "../src/transport.js";
import { MAX_FRAME_BYTES, newAgentId, type AgentState, type AgentMessage, type PeerInfo } from "../src/protocol.js";

const rootDir = process.argv[2];
const mode = process.argv[3] ?? "accept";
const projectId = process.argv[4];
const projectName = process.argv[5];
if (!rootDir || !projectId || !projectName) throw new Error("Missing isolated peer project scope");
let state: AgentState = "idle";
let count = 0;
const blocked = new Set<() => void>();

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (["foreign-response", "foreign-receipt", "foreign-error"].includes(mode)) {
  const agentId = newAgentId();
  const foreignProjectId = `project-${(projectId === `project-${"b".repeat(32)}` ? "a" : "b").repeat(32)}`;
  const info: PeerInfo = {
    agentId, projectId, projectName, pid: process.pid, cwd: rootDir,
    sessionId: "native-response-session", state, startedAt: new Date().toISOString(),
  };
  const namespace = join(rootDir, projectId);
  await mkdir(namespace, { recursive: true, mode: 0o700 });
  const connections = new Set<IpcConnection>();
  const server = await IpcServer.listen(ipcEndpoint(namespace, agentId), {
    framing: "lines", maxFrameBytes: MAX_FRAME_BYTES,
  }, connection => {
    connections.add(connection);
    connection.start(line => {
      const request = JSON.parse(line) as { from: string; message: AgentMessage };
      count++;
      emit({ type: "received", message: request.message });
      const response = mode === "foreign-error" ? {
        version: 2, projectId: foreignProjectId, kind: "error", from: agentId, to: request.from,
        error: "foreign fixture rejection",
      } : {
        version: 2, projectId: mode === "foreign-response" ? foreignProjectId : projectId,
        kind: "receipt", from: agentId, to: request.from,
        receipt: {
          projectId: mode === "foreign-receipt" ? foreignProjectId : projectId,
          messageId: request.message.messageId, from: agentId, to: request.from,
          accepted: true, duplicate: false, receivedAt: new Date().toISOString(),
        },
      };
      connection.send(JSON.stringify(response));
      connection.end();
    }, () => connections.delete(connection));
  });
  const input = createInterface({ input: process.stdin });
  emit({ type: "ready", info });
  await new Promise<void>(resolve => {
    input.on("close", resolve);
    input.on("line", line => {
      const command = JSON.parse(line) as { id: number; action: string };
      if (command.action === "count") emit({ type: "result", id: command.id, result: count });
      else if (command.action === "close") input.close();
      else emit({ type: "fatal", error: "Unknown native fixture command" });
    });
  });
  for (const connection of connections) connection.destroy();
  await server.close();
  process.exit(0);
}

const peer = await LocalPeer.start({
  rootDir,
  metadata: { cwd: rootDir, sessionId: "subprocess-session", projectId, projectName },
  getState: () => state,
  onMessage: async message => {
    count++;
    emit({ type: "received", message });
    if (mode === "reject") throw new Error("fixture rejects delivery");
    if (mode === "hold") await new Promise<void>(resolve => blocked.add(resolve));
  },
});

function closePeer(): Promise<void> {
  const closing = peer.close();
  for (const release of blocked) release();
  blocked.clear();
  return closing;
}

const input = createInterface({ input: process.stdin });
input.on("line", line => {
  void (async () => {
    const command = JSON.parse(line) as {
      id: number;
      action: string;
      cwd?: string;
      sessionId?: string;
      projectId?: string;
      projectName?: string;
      state?: AgentState;
    };
    if (command.action === "close") {
      await closePeer();
      process.stdout.write(`${JSON.stringify({ type: "result", id: command.id, result: "closed" })}\n`, () => process.exit(0));
      return;
    }
    if (command.action === "release") {
      for (const release of blocked) release();
      blocked.clear();
    } else if (command.action === "update") {
      const current = peer.info();
      try {
        await peer.updateMetadata({
          cwd: command.cwd ?? current.cwd,
          sessionId: command.sessionId ?? current.sessionId,
          projectId: command.projectId ?? current.projectId,
          projectName: command.projectName ?? current.projectName,
        });
      } catch (error) {
        emit({ type: "result", id: command.id, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      state = command.state ?? state;
    } else if (command.action === "list") {
      emit({ type: "result", id: command.id, result: await peer.list() });
      return;
    } else if (command.action !== "count") {
      throw new Error("Unknown fixture command");
    }
    emit({ type: "result", id: command.id, result: command.action === "count" ? count : peer.info() });
  })().catch(error => {
    emit({ type: "fatal", error: error instanceof Error ? error.message : String(error) });
    void closePeer().finally(() => process.exit(1));
  });
});
input.once("close", () => {
  void closePeer().catch(error => {
    emit({ type: "fatal", error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
});
emit({ type: "ready", info: peer.info() });
