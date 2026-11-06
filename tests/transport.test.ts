import { afterEach, describe, expect, test } from "bun:test";
import { IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  MAX_FRAME_BYTES,
  MAX_TEXT_BYTES,
  newAgentId,
  newConversationId,
  newMessageId,
  type AgentMessage,
  type PeerInfo,
} from "../src/protocol.js";
import { LocalPeer } from "../src/transport.js";

type FixtureEvent = { type: string; info?: PeerInfo; message?: AgentMessage; id?: number; result?: unknown; error?: string };

const PROJECT_ID = `project-${"a".repeat(32)}`;
const posixTest = process.platform === "win32" ? test.skip : test;
const OTHER_PROJECT_ID = `project-${"b".repeat(32)}`;
const PROJECT_NAME = "fixture-project";

function namespace(rootDir: string, projectId = PROJECT_ID): string {
  return join(rootDir, projectId);
}

class Fixture {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  readonly #events: FixtureEvent[] = [];
  readonly #waiters: Array<{ match: (event: FixtureEvent) => boolean; resolve: (event: FixtureEvent) => void; reject: (error: Error) => void }> = [];
  #sequence = 0;
  #stderr = "";
  #exitError: Error | undefined;
  info!: PeerInfo;
  #closing: Promise<void> | undefined;

  constructor(rootDir: string, mode: string, projectId: string) {
    this.child = spawn(process.execPath, [fileURLToPath(new URL("./peer-process.ts", import.meta.url)), rootDir, mode, projectId, PROJECT_NAME], {
      cwd: rootDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", data => { this.#stderr += String(data); });
    this.exited = new Promise(resolveExit => {
      this.child.once("close", code => {
        this.#exitError = new Error(`Peer fixture exited (${code}): ${this.#stderr}`);
        for (const waiter of this.#waiters.splice(0)) waiter.reject(this.#exitError);
        resolveExit(code);
      });
    });
    this.child.once("error", error => {
      this.#exitError = error;
      for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
    });
    createInterface({ input: this.child.stdout }).on("line", line => {
      const event = JSON.parse(line) as FixtureEvent;
      if (event.type === "fatal") {
        this.#exitError = new Error(event.error);
        for (const waiter of this.#waiters.splice(0)) waiter.reject(this.#exitError);
        return;
      }
      const index = this.#waiters.findIndex(waiter => waiter.match(event));
      if (index >= 0) this.#waiters.splice(index, 1)[0]!.resolve(event);
      else this.#events.push(event);
    });
  }

  async ready(): Promise<this> {
    this.info = (await this.waitFor("ready")).info!;
    endpoints.add(ipcEndpoint(namespace(this.info.cwd, this.info.projectId), this.info.agentId));
    return this;
  }

  waitFor(type: string, predicate: (event: FixtureEvent) => boolean = () => true): Promise<FixtureEvent> {
    const match = (event: FixtureEvent): boolean => event.type === type && predicate(event);
    const index = this.#events.findIndex(match);
    if (index >= 0) return Promise.resolve(this.#events.splice(index, 1)[0]!);
    if (this.#exitError) return Promise.reject(this.#exitError);
    return new Promise((resolveEvent, rejectEvent) => {
      const waiter = { match, resolve: resolveEvent, reject: rejectEvent };
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        rejectEvent(new Error(`Timed out waiting for fixture ${type}: ${this.#stderr}`));
      }, 10_000);
      waiter.resolve = event => { clearTimeout(timer); resolveEvent(event); };
      waiter.reject = error => { clearTimeout(timer); rejectEvent(error); };
      this.#waiters.push(waiter);
    });
  }

  async command(action: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.#sequence;
    const result = this.waitFor("result", event => event.id === id);
    this.child.stdin.write(`${JSON.stringify({ action, id, ...fields })}\n`);
    const event = await result;
    if (event.error) throw new Error(event.error);
    return event.result;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        await this.exited;
        return;
      }
      // EOF lets the fixture unregister normally; a stuck child must not survive a failed test.
      this.child.stdin.end();
      // This native cross-process deadline cannot be driven by a fake clock in the parent.
      const timer = setTimeout(() => this.child.kill("SIGKILL"), 5_000);
      try { await this.exited; }
      finally { clearTimeout(timer); }
    })();
    return this.#closing;
  }

  async kill(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    await this.exited;
  }
}

const peers: LocalPeer[] = [];
const fixtures: Fixture[] = [];
const roots: string[] = [];
const servers: IpcServer[] = [];
const connections = new Set<IpcConnection>();

const endpoints = new Set<string>();
afterEach(async () => {
  for (const connection of connections) connection.destroy();
  connections.clear();
  const outcomes = await Promise.allSettled([
    ...peers.splice(0).map(peer => peer.close()),
    ...fixtures.splice(0).map(fixture => fixture.close()),
    ...servers.splice(0).map(server => server.close()),
  ]);
  // Long Unix paths use a shared native fallback directory outside each fixture root.
  // Remove only these isolated endpoints/lock sidecars after every child has exited.
  if (process.platform !== "win32") {
    outcomes.push(...await Promise.allSettled([...endpoints].flatMap(endpoint => [
      rm(endpoint, { force: true }), rm(`${endpoint}.bind.lock`, { force: true }),
    ])));
  }
  endpoints.clear();
  outcomes.push(...await Promise.allSettled(roots.splice(0).map(rootDir => rm(rootDir, { recursive: true, force: true }))));
  const errors = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected").map(outcome => outcome.reason);
  if (errors.length) throw new AggregateError(errors, "Failed to clean up isolated transport fixtures");
});

async function root(directory = tmpdir(), prefix = "omp-session-bus-test-"): Promise<string> {
  const rootDir = await mkdtemp(join(directory, prefix));
  roots.push(rootDir);
  return rootDir;
}

async function local(rootDir: string, projectId = PROJECT_ID): Promise<LocalPeer> {
  const peer = await LocalPeer.start({
    rootDir,
    metadata: { cwd: rootDir, sessionId: "parent-session", projectId, projectName: PROJECT_NAME },
    getState: () => "idle",
    onMessage: () => undefined,
  });
  peers.push(peer);
  endpoints.add(ipcEndpoint(namespace(rootDir, projectId), peer.agentId));
  return peer;
}

async function child(rootDir: string, mode = "accept", projectId = PROJECT_ID): Promise<Fixture> {
  const fixture = new Fixture(rootDir, mode, projectId);
  fixtures.push(fixture);
  return fixture.ready();
}

function message(from: string, to: string, text = "Hello\nsecond line\r\n你好 👋\n\"quoted\" \\ backslash", projectId = PROJECT_ID): AgentMessage {
  return {
    version: 2, projectId, messageId: newMessageId(), conversationId: newConversationId(), from, to,
    inReplyTo: null, kind: "message", text, turn: 0, maxTurns: 8, finished: false,
  };
}

function delivery(from: string, to: string, content = message(from, to)): unknown {
  return { version: 2, projectId: content.projectId, kind: "deliver", from, to, message: content };
}

async function raw(rootDir: string, to: string, text: string, projectId = PROJECT_ID): Promise<Record<string, unknown> | null> {
  const connection = await IpcConnection.connect(ipcEndpoint(namespace(rootDir, projectId), to), {
    framing: "lines", maxFrameBytes: MAX_FRAME_BYTES, timeoutMs: 2_000,
  });
  connections.add(connection);
  return new Promise((resolveReply, rejectReply) => {
    const timer = setTimeout(() => {
      connection.destroy();
      rejectReply(new Error("Timed out waiting for raw peer response"));
    }, 3_000);
    let settled = false;
    const finish = (value: Record<string, unknown> | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connections.delete(connection);
      connection.destroy();
      resolveReply(value);
    };
    connection.start(line => { finish(JSON.parse(line) as Record<string, unknown>); }, () => finish(null));
    connection.send(text);
  });
}

describe("native local peer transport across independent processes", () => {
  test("delivers across independent processes under a Unicode directory", async () => {
    const rootDir = join(await root(), "会话 α 👋");
    await mkdir(rootDir);
    const sender = await local(rootDir);
    const receiver = await child(rootDir);
    const content = message(sender.agentId, receiver.info.agentId);
    expect((await sender.send(content)).messageId).toBe(content.messageId);
    expect((await receiver.waitFor("received")).message).toEqual(content);
    expect((await sender.list()).find(info => info.agentId === receiver.info.agentId)?.cwd).toBe(rootDir);
  }, 20_000);

  test("stdin EOF unregisters a child and settles callback-blocked delivery", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    const receiver = await child(rootDir, "hold");
    const sending = sender.send(message(sender.agentId, receiver.info.agentId)).then(
      () => "accepted", error => String(error),
    );
    await receiver.waitFor("received");
    await receiver.close();
    expect(await receiver.exited).toBe(0);
    expect(await sending).not.toBe("accepted");
    await expect(lstat(join(namespace(rootDir), `${receiver.info.agentId}.json`))).rejects.toThrow();
    expect((await sender.list()).map(info => info.agentId)).toEqual([sender.agentId]);
  }, 20_000);

  test("delivers intact multiline envelopes and correlates simultaneous receipts", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    const receiver = await child(rootDir);
    expect(receiver.info.pid).not.toBe(process.pid);
    const messages = Array.from({ length: 10 }, (_, index) => message(sender.agentId, receiver.info.agentId, `#${index}\nα\r\n你好 👋\n\"quoted\" \\`));
    const receipts = await Promise.all(messages.map(content => sender.send(content)));
    for (let index = 0; index < messages.length; index++) {
      const content = messages[index]!;
      expect((await receiver.waitFor("received", event => event.message?.messageId === content.messageId)).message).toEqual(content);
      expect(receipts[index]).toMatchObject({
        projectId: PROJECT_ID, messageId: content.messageId, from: receiver.info.agentId, to: sender.agentId, accepted: true, duplicate: false,
      });
      expect(Number.isFinite(Date.parse(receipts[index]!.receivedAt))).toBe(true);
    }
    expect(await receiver.command("count")).toBe(messages.length);
    expect((await sender.list()).map(info => info.agentId).sort()).toEqual([sender.agentId, receiver.info.agentId].sort());
  }, 20_000);

  test("isolates discovery and known addresses between projects sharing a base", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    const receiver = await child(rootDir);
    const foreign = await child(rootDir, "accept", OTHER_PROJECT_ID);
    expect(receiver.info.projectId).toBe(PROJECT_ID);
    expect(foreign.info.projectId).toBe(OTHER_PROJECT_ID);
    expect((await sender.list()).map(info => info.agentId).sort()).toEqual([sender.agentId, receiver.info.agentId].sort());
    expect((await foreign.command("list") as PeerInfo[]).map(info => info.agentId)).toEqual([foreign.info.agentId]);
    await expect(sender.send(message(sender.agentId, foreign.info.agentId))).rejects.toThrow();
    await expect(sender.send(message(sender.agentId, foreign.info.agentId, "wrong group", OTHER_PROJECT_ID))).rejects.toThrow("project");
    expect(await foreign.command("count")).toBe(0);
    expect(await receiver.command("count")).toBe(0);
    expect((await sender.send(message(sender.agentId, receiver.info.agentId))).projectId).toBe(PROJECT_ID);
    expect(await receiver.command("count")).toBe(1);
  }, 20_000);

  test("rejects forged cross-project frames and nested envelopes before callbacks", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    const receiver = await child(rootDir);
    const from = sender.agentId;
    const to = receiver.info.agentId;
    const content = message(from, to);
    const frames = [
      { version: 2, projectId: OTHER_PROJECT_ID, kind: "ping", from, to },
      { version: 2, projectId: OTHER_PROJECT_ID, kind: "deliver", from, to, message: content },
      { version: 2, projectId: PROJECT_ID, kind: "deliver", from, to, message: { ...content, projectId: OTHER_PROJECT_ID } },
      { version: 2, kind: "ping", from, to },
      { version: 2, projectId: PROJECT_ID, kind: "deliver", from, to, message: { ...content, projectId: undefined } },
    ];
    for (const forged of frames) {
      expect(await raw(rootDir, to, JSON.stringify(forged))).toMatchObject({ kind: "error", projectId: PROJECT_ID });
    }
    expect(await receiver.command("count")).toBe(0);
    expect(await raw(rootDir, to, JSON.stringify({ version: 2, projectId: PROJECT_ID, kind: "ping", from, to }))).toMatchObject({
      kind: "pong", projectId: PROJECT_ID, info: { agentId: to, projectId: PROJECT_ID },
    });
    expect(await raw(rootDir, to, JSON.stringify(delivery(from, to)))).toMatchObject({
      kind: "receipt", projectId: PROJECT_ID, receipt: { projectId: PROJECT_ID, accepted: true },
    });
    expect(await receiver.command("count")).toBe(1);
  }, 20_000);

  test("cannot migrate a live process endpoint through metadata updates", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    const receiver = await child(rootDir);
    const publicationPath = join(namespace(rootDir), `${receiver.info.agentId}.json`);
    const original = await readFile(publicationPath, "utf8");
    const generation = await stat(publicationPath);
    await expect(receiver.command("update", {
      projectId: OTHER_PROJECT_ID, cwd: join(rootDir, "foreign"), sessionId: "foreign-session", state: "busy",
    })).rejects.toThrow("Cannot change the project");
    expect((await sender.list()).find(info => info.agentId === receiver.info.agentId)).toEqual(receiver.info);
    expect(await readFile(publicationPath, "utf8")).toBe(original);
    const unchanged = await stat(publicationPath);
    expect({ dev: unchanged.dev, ino: unchanged.ino }).toEqual({ dev: generation.dev, ino: generation.ino });
    await expect(stat(namespace(rootDir, OTHER_PROJECT_ID))).rejects.toThrow();
    expect((await sender.send(message(sender.agentId, receiver.info.agentId))).accepted).toBe(true);
    expect(await receiver.command("count")).toBe(1);
  }, 20_000);

  test("rejects invalid namespace metadata and outgoing message projects", async () => {
    const rootDir = await root();
    const metadata = { cwd: rootDir, sessionId: "invalid-scope-session", projectId: PROJECT_ID, projectName: PROJECT_NAME };
    for (const projectId of ["", "project-a", "../foreign-project"]) {
      await expect(LocalPeer.start({
        rootDir, metadata: { ...metadata, projectId }, getState: () => "idle", onMessage: () => undefined,
      })).rejects.toThrow("metadata");
    }
    await expect(LocalPeer.start({
      rootDir, metadata: { ...metadata, projectName: " " }, getState: () => "idle", onMessage: () => undefined,
    })).rejects.toThrow("metadata");
    const sender = await local(rootDir);
    const receiver = await child(rootDir);
    for (const projectId of ["", "project-a", OTHER_PROJECT_ID]) {
      await expect(sender.send(message(sender.agentId, receiver.info.agentId, "wrong scope", projectId))).rejects.toThrow();
    }
    expect(await receiver.command("count")).toBe(0);
    expect((await sender.send(message(sender.agentId, receiver.info.agentId))).accepted).toBe(true);
  }, 20_000);

  test("emits acceptance only after the receiver callback succeeds", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    const receiver = await child(rootDir, "hold");
    const content = message(sender.agentId, receiver.info.agentId);
    let settled = false;
    const sending = sender.send(content).then(receipt => { settled = true; return receipt; });
    await receiver.waitFor("received");
    expect(await receiver.command("count")).toBe(1);
    expect(settled).toBe(false);
    await receiver.command("release");
    expect((await sending).messageId).toBe(content.messageId);
  }, 20_000);

  test("returns receiver exceptions as explicit delivery rejections", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    const receiver = await child(rootDir, "reject");
    await expect(sender.send(message(sender.agentId, receiver.info.agentId))).rejects.toThrow("Peer rejected request: fixture rejects delivery");
    expect(await receiver.command("count")).toBe(1);
  }, 20_000);

  test("excludes a killed process despite its remaining publication", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    const receiver = await child(rootDir);
    expect((await sender.list()).some(info => info.agentId === receiver.info.agentId)).toBe(true);
    await receiver.kill();
    expect((await stat(join(namespace(rootDir), `${receiver.info.agentId}.json`))).isFile()).toBe(true);
    expect((await sender.list()).map(info => info.agentId)).toEqual([sender.agentId]);
    await expect(sender.send(message(sender.agentId, receiver.info.agentId))).rejects.toThrow();
  }, 20_000);

  test("unregisters only its own generation and closes idempotently", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    const receiver = await child(rootDir);
    const stale = newAgentId();
    const stalePath = join(namespace(rootDir), `${stale}.json`);
    await writeFile(stalePath, JSON.stringify({ ...receiver.info, agentId: stale }), { mode: 0o600 });
    await receiver.command("close");
    await receiver.exited;
    await expect(stat(join(namespace(rootDir), `${receiver.info.agentId}.json`))).rejects.toThrow();
    expect((await sender.list()).map(info => info.agentId)).toEqual([sender.agentId]);
    expect((await stat(stalePath)).isFile()).toBe(true);
    const closing = sender.close();
    expect(sender.close()).toBe(closing);
    await closing;
    await expect(stat(join(namespace(rootDir), `${sender.agentId}.json`))).rejects.toThrow();
    expect((await stat(stalePath)).isFile()).toBe(true);
    await expect(sender.list()).rejects.toThrow("closed");
    await expect(sender.send(message(sender.agentId, receiver.info.agentId))).rejects.toThrow("closed");
  }, 20_000);

  test("uses current ping metadata rather than racing publication rewrites", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    const receiver = await child(rootDir);
    const publicationPath = join(namespace(rootDir), `${receiver.info.agentId}.json`);
    const original = await readFile(publicationPath, "utf8");
    await receiver.command("update", { cwd: join(rootDir, "new-project"), sessionId: "new-session", projectName: "renamed-project", state: "busy" });
    expect((await sender.list()).find(info => info.agentId === receiver.info.agentId)).toMatchObject({
      cwd: join(rootDir, "new-project"), sessionId: "new-session", projectId: PROJECT_ID, projectName: "renamed-project", state: "busy",
    });
    expect(await readFile(publicationPath, "utf8")).toBe(original);
  }, 20_000);

  test("does not trust arbitrary endpoints or filename/metadata ID mismatches", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    const receiver = await child(rootDir);
    const fake = newAgentId();
    const mismatch = newAgentId();
    await writeFile(join(namespace(rootDir), `${fake}.json`), JSON.stringify({
      ...receiver.info, agentId: fake, endpoint: ipcEndpoint(namespace(rootDir), receiver.info.agentId),
    }), { mode: 0o600 });
    await writeFile(join(namespace(rootDir), `${mismatch}.json`), JSON.stringify(receiver.info), { mode: 0o600 });
    await writeFile(join(namespace(rootDir), "not-an-agent.json"), JSON.stringify(receiver.info), { mode: 0o600 });
    expect((await sender.list()).map(info => info.agentId).sort()).toEqual([sender.agentId, receiver.info.agentId].sort());
    expect(await receiver.command("count")).toBe(0);
  }, 20_000);

  test("rejects invalid outgoing identities, addresses, text sizes, and encoded frame sizes", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    const receiver = await child(rootDir);
    await expect(sender.send(message(newAgentId(), receiver.info.agentId))).rejects.toThrow("sender");
    await expect(sender.send(message(sender.agentId, sender.agentId))).rejects.toThrow();
    await expect(sender.send(message(sender.agentId, "../../foreign.sock"))).rejects.toThrow();
    await expect(sender.send(message(sender.agentId, receiver.info.agentId, "x".repeat(MAX_TEXT_BYTES + 1)))).rejects.toThrow();
    await expect(sender.send(message(sender.agentId, receiver.info.agentId, "\u0000".repeat(MAX_TEXT_BYTES)))).rejects.toThrow("frame is too large");
    expect(await receiver.command("count")).toBe(0);
  }, 20_000);

  test("does not inject malformed frames, wrong addresses, or mismatched envelope senders", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    const receiver = await child(rootDir);
    const to = receiver.info.agentId;
    const from = sender.agentId;
    const frames = [
      "not JSON", "[]", "null",
      JSON.stringify({ version: 1, projectId: PROJECT_ID, kind: "ping", from, to }),
      JSON.stringify({ version: 2, projectId: PROJECT_ID, kind: "ping", from, to: newAgentId() }),
      JSON.stringify({ version: 2, projectId: PROJECT_ID, kind: "deliver", from: "not-live-id", to, message: message(from, to) }),
      JSON.stringify(delivery(from, to, message(newAgentId(), to))),
      JSON.stringify(delivery(from, to, message(from, newAgentId()))),
      JSON.stringify(delivery(to, to, message(to, to))),
      JSON.stringify({ version: 2, projectId: PROJECT_ID, kind: "unknown", from, to }),
      JSON.stringify({ version: 2, projectId: PROJECT_ID, kind: "deliver", from, to, message: {} }),
    ];
    for (const text of frames) expect((await raw(rootDir, to, text))?.kind).toBe("error");
    expect(await raw(rootDir, to, "x".repeat(MAX_FRAME_BYTES + 1))).toBeNull();
    expect(await receiver.command("count")).toBe(0);
    expect((await sender.send(message(from, to))).accepted).toBe(true);
  }, 20_000);

  test("bounds concurrent requests and close settles every pending delivery", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    const receiver = await child(rootDir, "hold");
    const messages = Array.from({ length: 16 }, () => message(sender.agentId, receiver.info.agentId));
    const pending = messages.map(content => sender.send(content).then(() => "accepted", error => String(error)));
    await expect(sender.send(message(sender.agentId, receiver.info.agentId))).rejects.toThrow("connection limit");
    for (const content of messages) await receiver.waitFor("received", event => event.message?.messageId === content.messageId);
    expect(await receiver.command("count")).toBe(messages.length);
    await sender.close();
    for (const outcome of await Promise.all(pending)) expect(outcome).toContain("closed before receiving a response");
    await receiver.command("close");
    await receiver.exited;
  }, 20_000);

  test("receiver close destroys idle and callback-blocked accepted connections", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    const receiver = await child(rootDir, "hold");
    const idle = await IpcConnection.connect(ipcEndpoint(namespace(rootDir), receiver.info.agentId), {
      framing: "lines", maxFrameBytes: MAX_FRAME_BYTES, timeoutMs: 2_000,
    });
    connections.add(idle);
    const idleClosed = new Promise<void>((resolveClose, rejectClose) => {
      const timer = setTimeout(() => rejectClose(new Error("Receiver left an accepted connection open")), 2_000);
      idle.start(() => rejectClose(new Error("Unexpected idle connection frame")), () => {
        clearTimeout(timer);
        connections.delete(idle);
        resolveClose();
      });
    });
    const sending = sender.send(message(sender.agentId, receiver.info.agentId)).then(
      () => "accepted", error => String(error),
    );
    await receiver.waitFor("received");
    await receiver.command("close");
    await idleClosed;
    expect(await sending).not.toBe("accepted");
    await receiver.exited;
  }, 20_000);

  test("times out without retrying a callback that does not finish", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    const receiver = await child(rootDir, "hold");
    await expect(sender.send(message(sender.agentId, receiver.info.agentId))).rejects.toThrow("timed out");
    expect(await receiver.command("count")).toBe(1);
  }, 20_000);
});

describe("negative native protocol responses", () => {
  test("rejects cross-project receipts and errors from independent native responders", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    for (const mode of ["foreign-response", "foreign-receipt", "foreign-error"]) {
      const receiver = await child(rootDir, mode);
      expect(receiver.info.pid).not.toBe(process.pid);
      await expect(sender.send(message(sender.agentId, receiver.info.agentId))).rejects.toThrow(
        mode === "foreign-receipt" ? "delivery receipt" : "another project",
      );
      expect(await receiver.command("count")).toBe(1);
    }
  }, 20_000);

  test("rejects foreign publications, pong frames, and embedded peer metadata", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    const target = newAgentId();
    const info: PeerInfo = { ...sender.info(), agentId: target };
    const publicationPath = join(namespace(rootDir), `${target}.json`);
    let probes = 0;
    let corrupt: (response: Record<string, unknown>) => unknown = response => response;
    const server = await IpcServer.listen(ipcEndpoint(namespace(rootDir), target), {
      framing: "lines", maxFrameBytes: MAX_FRAME_BYTES,
    }, connection => {
      connections.add(connection);
      connection.start(line => {
        const request = JSON.parse(line) as { from: string };
        probes++;
        connection.send(JSON.stringify(corrupt({
          version: 2, projectId: PROJECT_ID, kind: "pong", from: target, to: request.from, info,
        })));
        connection.end();
      }, () => connections.delete(connection));
    });
    servers.push(server);
    endpoints.add(server.endpoint);
    await writeFile(publicationPath, JSON.stringify({ ...info, projectId: OTHER_PROJECT_ID }), { mode: 0o600 });
    expect((await sender.list()).map(peer => peer.agentId)).toEqual([sender.agentId]);
    expect(probes).toBe(0);
    await writeFile(publicationPath, JSON.stringify(info), { mode: 0o600 });
    const corruptions: Array<(response: Record<string, unknown>) => unknown> = [
      response => ({ ...response, projectId: OTHER_PROJECT_ID }),
      response => ({ ...response, projectId: undefined }),
      response => ({ ...response, info: { ...info, projectId: OTHER_PROJECT_ID } }),
      response => ({ ...response, info: { ...info, projectId: undefined } }),
      response => ({ ...response, info: { ...info, projectName: "" } }),
    ];
    for (const corruption of corruptions) {
      corrupt = corruption;
      expect((await sender.list()).map(peer => peer.agentId)).toEqual([sender.agentId]);
    }
    expect(probes).toBe(corruptions.length);
    corrupt = response => response;
    expect((await sender.list()).map(peer => peer.agentId).sort()).toEqual([sender.agentId, target].sort());
  }, 20_000);

  test("rejects malformed and uncorrelated receipts instead of reporting acceptance", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    const target = newAgentId();
    let corrupt: (response: Record<string, unknown>) => unknown = response => response;
    // A deliberately hostile native responder is needed to exercise responses LocalPeer never emits.
    const server = await IpcServer.listen(ipcEndpoint(namespace(rootDir), target), {
      framing: "lines", maxFrameBytes: MAX_FRAME_BYTES,
    }, connection => {
      connections.add(connection);
      connection.start(line => {
        const request = JSON.parse(line) as { message: AgentMessage };
        const response = {
          version: 2, projectId: PROJECT_ID, kind: "receipt", from: target, to: sender.agentId,
          receipt: {
            projectId: PROJECT_ID, messageId: request.message.messageId, from: target, to: sender.agentId,
            accepted: true, duplicate: false, receivedAt: new Date().toISOString(),
          },
        };
        connection.send(JSON.stringify(corrupt(response)));
        connection.end();
      }, () => connections.delete(connection));
    });
    servers.push(server);
    endpoints.add(server.endpoint);
    const alterReceipt = (fields: Record<string, unknown>) => (response: Record<string, unknown>): unknown => ({
      ...response, receipt: { ...(response.receipt as object), ...fields },
    });
    const corruptions: Array<(response: Record<string, unknown>) => unknown> = [
      alterReceipt({ projectId: OTHER_PROJECT_ID }),
      alterReceipt({ projectId: undefined }),
      alterReceipt({ messageId: newMessageId() }),
      alterReceipt({ from: newAgentId() }),
      alterReceipt({ to: newAgentId() }),
      alterReceipt({ accepted: false }),
      alterReceipt({ duplicate: "false" }),
      alterReceipt({ receivedAt: "invalid-date" }),
      response => ({ ...response, from: newAgentId() }),
      response => ({ ...response, to: newAgentId() }),
      response => ({ ...response, version: 1 }),
      response => ({ ...response, projectId: OTHER_PROJECT_ID }),
      response => ({ ...response, projectId: undefined }),
      response => ({ ...response, kind: "pong", info: sender.info() }),
      response => ({ ...response, receipt: null }),
    ];
    for (const corruption of corruptions) {
      corrupt = corruption;
      await expect(sender.send(message(sender.agentId, target))).rejects.toThrow();
    }
    corrupt = response => response;
    expect((await sender.send(message(sender.agentId, target))).projectId).toBe(PROJECT_ID);
  }, 20_000);

  test("does not remove a replacement publication belonging to another inode", async () => {
    const rootDir = await root();
    const peer = await local(rootDir);
    const path = join(namespace(rootDir), `${peer.agentId}.json`);
    await rename(path, join(namespace(rootDir), "saved-generation.json"));
    await writeFile(path, "replacement publication", { mode: 0o600 });
    await peer.close();
    expect(await readFile(path, "utf8")).toBe("replacement publication");
  });
});

describe("POSIX Unix socket behavior", () => {
  posixTest("delivers through real Unix sockets with private directories and publications", async () => {
    // /tmp keeps this endpoint below even macOS's shorter sun_path limit.
    const rootDir = await root("/tmp", "osb-");
    await chmod(rootDir, 0o777);
    await mkdir(namespace(rootDir), { mode: 0o777 });
    await chmod(namespace(rootDir), 0o777);
    const sender = await local(rootDir);
    const receiver = await child(rootDir);
    for (const path of [rootDir, namespace(rootDir)]) {
      const directory = await lstat(path);
      expect(directory.isDirectory()).toBe(true);
      expect(directory.uid).toBe(process.geteuid!());
      expect(directory.mode & 0o777).toBe(0o700);
    }
    for (const peer of [sender.info(), receiver.info]) {
      const endpoint = ipcEndpoint(namespace(rootDir), peer.agentId);
      expect(endpoint).toBe(join(namespace(rootDir), `${peer.agentId}.sock`));
      const socket = await lstat(endpoint);
      expect(socket.isSocket()).toBe(true);
      expect(socket.uid).toBe(process.geteuid!());
      expect(socket.mode & 0o777).toBe(0o600);
      const publication = await lstat(join(namespace(rootDir), `${peer.agentId}.json`));
      expect(publication.isFile()).toBe(true);
      expect(publication.uid).toBe(process.geteuid!());
      expect(publication.mode & 0o777).toBe(0o600);
    }
    const content = message(sender.agentId, receiver.info.agentId, "Unix socket\n你好 α 👋");
    expect((await sender.send(content)).accepted).toBe(true);
    expect((await receiver.waitFor("received")).message).toEqual(content);
    const endpoint = ipcEndpoint(namespace(rootDir), receiver.info.agentId);
    await receiver.close();
    expect(await receiver.exited).toBe(0);
    await expect(lstat(endpoint)).rejects.toThrow();
  }, 20_000);

  posixTest("uses the native short endpoint for long Unicode paths without losing project isolation", async () => {
    const base = await root();
    const rootDir = join(base, ...Array.from({ length: 4 }, (_, index) => `路径 α ${index}-${"long".repeat(20)}`));
    await mkdir(rootDir, { recursive: true });
    const sender = await local(rootDir);
    const receiver = await child(rootDir);
    const foreign = await child(rootDir, "accept", OTHER_PROJECT_ID);
    const directPath = join(namespace(rootDir), `${receiver.info.agentId}.sock`);
    const endpoint = ipcEndpoint(namespace(rootDir), receiver.info.agentId);
    expect(Buffer.byteLength(directPath)).toBeGreaterThan(108);
    expect(endpoint).not.toBe(directPath);
    expect(Buffer.byteLength(endpoint)).toBeLessThan(104);
    const socket = await lstat(endpoint);
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o600);
    const fallback = await lstat(dirname(endpoint));
    expect(fallback.isDirectory()).toBe(true);
    expect(fallback.uid).toBe(process.geteuid!());
    expect(fallback.mode & 0o777).toBe(0o700);
    const content = message(sender.agentId, receiver.info.agentId, "long-path delivery\nα 你好 👋");
    expect((await sender.send(content)).accepted).toBe(true);
    expect((await receiver.waitFor("received")).message).toEqual(content);
    expect((await sender.list()).map(info => info.agentId).sort()).toEqual([sender.agentId, receiver.info.agentId].sort());
    await expect(sender.send(message(sender.agentId, foreign.info.agentId))).rejects.toThrow();
    expect(await foreign.command("count")).toBe(0);
    await receiver.close();
    await expect(lstat(endpoint)).rejects.toThrow();
  }, 20_000);

  posixTest("rejects symlinked and non-directory roots without touching their targets", async () => {
    const base = await root();
    const target = join(base, "target");
    await mkdir(target);
    await chmod(target, 0o755);
    const alias = join(base, "alias");
    await symlink(target, alias, "dir");
    await expect(local(alias)).rejects.toThrow("real directory");
    expect((await lstat(target)).mode & 0o777).toBe(0o755);
    expect(await readdir(target)).toEqual([]);

    const scoped = join(base, "scoped");
    await mkdir(scoped);
    await symlink(target, namespace(scoped), "dir");
    await expect(local(scoped)).rejects.toThrow("real directory");
    expect((await lstat(target)).mode & 0o777).toBe(0o755);
    expect(await readdir(target)).toEqual([]);

    const file = join(base, "file");
    await writeFile(file, "not a directory");
    await expect(local(file)).rejects.toThrow();
    const fileScope = join(base, "file-scope");
    await mkdir(fileScope);
    await writeFile(namespace(fileScope), "not a namespace");
    await expect(local(fileScope)).rejects.toThrow();
    expect(await readFile(namespace(fileScope), "utf8")).toBe("not a namespace");
  });

  // Changing a fixture UID requires root; ordinary Linux/macOS runners skip this case.
  (process.platform !== "win32" && process.geteuid!() === 0 ? test : test.skip)("rejects roots owned by another UID before changing permissions", async () => {
    const base = await root();
    const foreignBase = join(base, "foreign-base");
    const foreignScope = join(base, "foreign-scope");
    for (const [rootDir, path] of [[foreignBase, foreignBase], [foreignScope, namespace(foreignScope)]] as const) {
      await mkdir(path, { recursive: true });
      await chmod(path, 0o755);
      await chown(path, 1, (await lstat(path)).gid);
      try {
        await expect(local(rootDir)).rejects.toThrow("owned by another user");
        expect((await lstat(path)).mode & 0o777).toBe(0o755);
        expect(await readdir(path)).toEqual([]);
      } finally {
        await chown(path, process.geteuid!(), process.getegid!());
      }
    }
  });

  posixTest("does not discover public or symlinked publications", async () => {
    const rootDir = await root();
    const sender = await local(rootDir);
    const receiver = await child(rootDir);
    const path = join(namespace(rootDir), `${receiver.info.agentId}.json`);
    await chmod(path, 0o644);
    expect((await sender.list()).map(info => info.agentId)).toEqual([sender.agentId]);
    await chmod(path, 0o600);
    expect((await sender.list()).some(info => info.agentId === receiver.info.agentId)).toBe(true);
    const saved = join(namespace(rootDir), "saved-private-publication");
    await rename(path, saved);
    await symlink(saved, path, "file");
    expect((await sender.list()).map(info => info.agentId)).toEqual([sender.agentId]);
    await receiver.close();
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(saved, "utf8")).agentId).toBe(receiver.info.agentId);
  }, 20_000);
});
