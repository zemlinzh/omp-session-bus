import { IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, link, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_ID_PATTERN,
  MAX_FRAME_BYTES,
  PROJECT_ID_PATTERN,
  PROTOCOL_VERSION,
  newAgentId,
  validateMessage,
  type AgentMessage,
  type AgentState,
  type MessageReceipt,
  type PeerInfo,
} from "./protocol.js";

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_CONNECTIONS = 64;
const MAX_OUTGOING_REQUESTS = 16;
const DISCOVERY_CONCURRENCY = 8;
const MAX_METADATA_BYTES = 16 * 1024;
const METADATA_FILENAME = /^(omp-[a-f0-9]{16})\.json$/;

type Metadata = { cwd: string; sessionId: string; projectId: string; projectName: string };
type Request =
  | { version: 2; projectId: string; kind: "ping"; from: string; to: string }
  | { version: 2; projectId: string; kind: "deliver"; from: string; to: string; message: AgentMessage };
type Response =
  | { version: 2; projectId: string; kind: "pong"; from: string; to: string; info: PeerInfo }
  | { version: 2; projectId: string; kind: "receipt"; from: string; to: string; receipt: MessageReceipt }
  | { version: 2; projectId: string; kind: "error"; from: string; to: string | null; error: string };

export interface LocalPeerOptions {
  rootDir?: string;
  metadata: Metadata;
  getState: () => AgentState;
  onMessage: (message: AgentMessage) => void | Promise<void>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid IPC envelope");
  return value as Record<string, unknown>;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateInfo(value: unknown): asserts value is PeerInfo {
  const info = object(value);
  if (
    typeof info.agentId !== "string" || !AGENT_ID_PATTERN.test(info.agentId) ||
    typeof info.projectId !== "string" || !PROJECT_ID_PATTERN.test(info.projectId) ||
    typeof info.projectName !== "string" || !info.projectName.trim() ||
    !Number.isSafeInteger(info.pid) || (info.pid as number) <= 0 ||
    typeof info.cwd !== "string" || !info.cwd ||
    typeof info.sessionId !== "string" ||
    (info.state !== "idle" && info.state !== "busy") || !validDate(info.startedAt)
  ) throw new Error("Invalid peer metadata");
}

function validateMetadata(metadata: Metadata): void {
  if (typeof metadata.cwd !== "string" || !metadata.cwd || typeof metadata.sessionId !== "string" ||
    typeof metadata.projectId !== "string" || !PROJECT_ID_PATTERN.test(metadata.projectId) ||
    typeof metadata.projectName !== "string" || !metadata.projectName.trim() ||
    Buffer.byteLength(JSON.stringify(metadata)) > MAX_METADATA_BYTES / 2) {
    throw new Error("Invalid local agent metadata");
  }
}

function frame(value: unknown): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new Error("IPC frame is too large");
  return text;
}

function parse(line: string): Record<string, unknown> {
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("IPC frame is too large");
  return object(JSON.parse(line));
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1024);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Same-user IPC only; native pipes/sockets enforce OS identity, not model identity. */
export class LocalPeer {
  readonly agentId = newAgentId();
  readonly #baseDir: string;
  readonly #projectId: string;
  readonly #rootDir: string;
  readonly #startedAt = new Date().toISOString();
  readonly #getState: () => AgentState;
  readonly #onMessage: LocalPeerOptions["onMessage"];
  readonly #connections = new Set<IpcConnection>();
  readonly #pending = new Set<() => void>();
  #metadata: Metadata;
  #server: IpcServer | undefined;
  #publication: { dev: number; ino: number } | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  #dialing = 0;
  #outgoing = 0;

  private constructor(options: LocalPeerOptions) {
    validateMetadata(options.metadata);
    this.#metadata = { ...options.metadata };
    this.#projectId = options.metadata.projectId;
    this.#baseDir = resolve(options.rootDir ?? join(homedir(), ".omp", "run", "session-bus"));
    this.#rootDir = join(this.#baseDir, this.#projectId);
    this.#getState = options.getState;
    this.#onMessage = options.onMessage;
  }

  static async start(options: LocalPeerOptions): Promise<LocalPeer> {
    const peer = new LocalPeer(options);
    for (const path of [peer.#baseDir, peer.#rootDir]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const directory = await lstat(path);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Agent root must be a real directory");
      if (process.platform !== "win32") {
        if (directory.uid !== process.geteuid!()) throw new Error("Agent root is owned by another user");
        await chmod(path, 0o700);
      }
    }
    try {
      peer.#server = await IpcServer.listen(peer.#endpoint(peer.agentId), {
        framing: "lines", maxFrameBytes: MAX_FRAME_BYTES,
      }, connection => peer.#accept(connection));
      peer.#server.unref();
      await peer.#publish();
      return peer;
    } catch (error) {
      await peer.close();
      throw error;
    }
  }

  info(): PeerInfo {
    const info: PeerInfo = {
      agentId: this.agentId,
      projectId: this.#projectId,
      projectName: this.#metadata.projectName,
      pid: process.pid,
      cwd: this.#metadata.cwd,
      sessionId: this.#metadata.sessionId,
      state: this.#getState(),
      startedAt: this.#startedAt,
    };
    validateInfo(info);
    return info;
  }

  async updateMetadata(metadata: Metadata): Promise<void> {
    this.#assertOpen();
    validateMetadata(metadata);
    if (metadata.projectId !== this.#projectId) throw new Error("Cannot change the project of a live local agent");
    // Publication identifies the generation; ping always derives current metadata/state.
    this.#metadata = { ...metadata };
  }

  async list(): Promise<PeerInfo[]> {
    this.#assertOpen();
    const peers: PeerInfo[] = [];
    let batch: Promise<void>[] = [];
    const directory = await opendir(this.#rootDir);
    for await (const entry of directory) {
      this.#assertOpen();
      const match = METADATA_FILENAME.exec(entry.name);
      if (!match || !entry.isFile()) continue;
      batch.push(this.#probe(match[1]!).then(info => { if (info) peers.push(info); }));
      if (batch.length === DISCOVERY_CONCURRENCY) {
        await Promise.all(batch);
        batch = [];
      }
    }
    await Promise.all(batch);
    this.#assertOpen();
    return peers.sort((a, b) => a.agentId.localeCompare(b.agentId));
  }

  async send(message: AgentMessage): Promise<MessageReceipt> {
    this.#assertOpen();
    validateMessage(message);
    if (message.projectId !== this.#projectId) throw new Error("Message project must be this live agent's project");
    if (message.from !== this.agentId) throw new Error("Message sender must be this live agent");
    if (message.to === this.agentId) throw new Error("Cannot send to the same agent");
    const sent = { ...message };
    const response = await this.#request(sent.to, {
      version: PROTOCOL_VERSION, projectId: this.#projectId, kind: "deliver", from: this.agentId, to: sent.to, message: sent,
    });
    if (response.kind !== "receipt") throw new Error("Expected a delivery receipt");
    return response.receipt;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    for (const cancel of [...this.#pending]) cancel();
    for (const connection of this.#connections) connection.destroy();
    this.#connections.clear();
    this.#closing = Promise.all([
      this.#server?.close(),
      this.#removePublication(),
    ]).then(() => undefined);
    return this.#closing;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Local agent is closed");
  }

  #endpoint(agentId: string): string {
    if (!AGENT_ID_PATTERN.test(agentId)) throw new Error("Invalid peer address");
    return ipcEndpoint(this.#rootDir, agentId);
  }

  #metadataPath(agentId: string): string {
    if (!AGENT_ID_PATTERN.test(agentId)) throw new Error("Invalid peer address");
    return join(this.#rootDir, `${agentId}.json`);
  }

  async #publish(): Promise<void> {
    const temporary = join(this.#rootDir, `.${this.agentId}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      const content = frame(this.info());
      if (Buffer.byteLength(content) > MAX_METADATA_BYTES) throw new Error("Peer metadata is too large");
      await handle.writeFile(content, "utf8");
      const { dev, ino } = await handle.stat();
      // A hard link publishes a complete file atomically without replacing another generation.
      await link(temporary, this.#metadataPath(this.agentId));
      this.#publication = { dev, ino };
    } finally {
      await handle.close();
      await unlink(temporary);
    }
  }

  async #removePublication(): Promise<void> {
    if (!this.#publication) return;
    const path = this.#metadataPath(this.agentId);
    try {
      const stat = await lstat(path);
      if (stat.isFile() && stat.dev === this.#publication.dev && stat.ino === this.#publication.ino) {
        await unlink(path);
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  async #readPublication(agentId: string): Promise<PeerInfo> {
    const path = this.#metadataPath(agentId);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_METADATA_BYTES ||
        (process.platform !== "win32" && (stat.uid !== process.geteuid!() || (stat.mode & 0o077) !== 0))) {
        throw new Error("Peer publication is not a private regular file");
      }
      const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_METADATA_BYTES) throw new Error("Peer publication is too large");
      const info: unknown = JSON.parse(buffer.toString("utf8", 0, bytesRead));
      validateInfo(info);
      if (info.agentId !== agentId) throw new Error("Peer filename and agent ID do not match");
      if (info.projectId !== this.#projectId) throw new Error("Peer publication belongs to another project");
      return info;
    } finally {
      await handle.close();
    }
  }

  async #probe(agentId: string): Promise<PeerInfo | null> {
    try {
      const publication = await this.#readPublication(agentId);
      const response = await this.#request(agentId, {
        version: PROTOCOL_VERSION, projectId: this.#projectId, kind: "ping", from: this.agentId, to: agentId,
      });
      if (response.kind !== "pong" || response.info.pid !== publication.pid ||
        response.info.startedAt !== publication.startedAt) return null;
      return response.info;
    } catch {
      // Stale, malformed, inaccessible, busy, or unreachable entries are not live peers.
      return null;
    }
  }

  #request(to: string, request: Request): Promise<Response> {
    this.#assertOpen();
    if (request.projectId !== this.#projectId) throw new Error("Request belongs to another project");
    const endpoint = this.#endpoint(to);
    const encoded = frame(request);
    if (this.#outgoing >= MAX_OUTGOING_REQUESTS || this.#connections.size + this.#dialing >= MAX_CONNECTIONS) {
      return Promise.reject(new Error("Local agent connection limit reached"));
    }
    this.#outgoing++;
    this.#dialing++;
    return new Promise<Response>((resolveRequest, rejectRequest) => {
      let connection: IpcConnection | undefined;
      let settled = false;
      const finish = (error: unknown, response?: Response): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#pending.delete(cancel);
        this.#outgoing--;
        if (connection) {
          this.#connections.delete(connection);
          connection.destroy();
        }
        if (error) rejectRequest(error);
        else resolveRequest(response!);
      };
      const cancel = (): void => finish(new Error("Local agent closed before receiving a response"));
      const timer = setTimeout(() => finish(new Error("Local agent request timed out")), REQUEST_TIMEOUT_MS);
      this.#pending.add(cancel);
      IpcConnection.connect(endpoint, {
        framing: "lines", maxFrameBytes: MAX_FRAME_BYTES, timeoutMs: REQUEST_TIMEOUT_MS,
      }).then(connected => {
        this.#dialing--;
        if (settled || this.#closed) { connected.destroy(); return; }
        connection = connected;
        this.#connections.add(connected);
        try {
          connected.start(line => {
            try { finish(null, this.#validateResponse(parse(line), request)); }
            catch (error) { finish(error); }
          }, reason => finish(new Error(reason ?? "Peer closed without a response")));
          if (!connected.send(encoded)) finish(new Error("Peer connection is closed or congested"));
        } catch (error) { finish(error); }
      }, error => { this.#dialing--; finish(error); });
    });
  }

  #validateResponse(value: Record<string, unknown>, request: Request): Response {
    if (value.version !== PROTOCOL_VERSION || value.from !== request.to || value.to !== this.agentId) {
      throw new Error("Uncorrelated peer response address");
    }
    if (value.projectId !== this.#projectId) {
      throw new Error("Peer response belongs to another project");
    }
    if (value.kind === "error") {
      if (typeof value.error !== "string" || !value.error) throw new Error("Malformed peer rejection");
      throw new Error(`Peer rejected request: ${value.error}`);
    }
    if (request.kind === "ping" && value.kind === "pong") {
      validateInfo(value.info);
      if (value.info.agentId !== request.to) throw new Error("Unexpected peer identity");
      if (value.info.projectId !== this.#projectId) throw new Error("Peer metadata belongs to another project");
      return value as unknown as Response;
    }
    if (request.kind === "deliver" && value.kind === "receipt") {
      const receipt = object(value.receipt);
      if (receipt.projectId !== this.#projectId || receipt.messageId !== request.message.messageId || receipt.from !== request.to ||
        receipt.to !== this.agentId || receipt.accepted !== true || typeof receipt.duplicate !== "boolean" ||
        !validDate(receipt.receivedAt)) throw new Error("Malformed or uncorrelated delivery receipt");
      return value as unknown as Response;
    }
    throw new Error("Unexpected peer response type");
  }

  #accept(connection: IpcConnection): void {
    if (this.#closed || this.#connections.size + this.#dialing >= MAX_CONNECTIONS) {
      connection.destroy();
      return;
    }
    this.#connections.add(connection);
    const timer = setTimeout(() => connection.destroy(), REQUEST_TIMEOUT_MS);
    let handled = false;
    connection.start(line => {
      if (handled) { connection.destroy(); return; }
      handled = true;
      void this.#receive(line, connection);
    }, () => {
      clearTimeout(timer);
      this.#connections.delete(connection);
    });
  }

  async #receive(line: string, connection: IpcConnection): Promise<void> {
    let sender: string | null = null;
    try {
      const request = parse(line);
      if (typeof request.from === "string" && AGENT_ID_PATTERN.test(request.from)) sender = request.from;
      if (request.version !== PROTOCOL_VERSION || sender === null || request.to !== this.agentId) {
        throw new Error("Invalid request version or address");
      }
      if (request.projectId !== this.#projectId) throw new Error("Request belongs to another project");
      let response: Response;
      if (request.kind === "ping") {
        response = { version: PROTOCOL_VERSION, projectId: this.#projectId, kind: "pong", from: this.agentId, to: sender, info: this.info() };
      } else if (request.kind === "deliver") {
        validateMessage(request.message);
        const message = request.message;
        if (message.projectId !== this.#projectId) throw new Error("Message belongs to another project");
        if (sender === this.agentId || message.from !== sender || message.to !== this.agentId) {
          throw new Error("Unexpected message sender or receiver");
        }
        const messageId = message.messageId;
        await this.#onMessage(message);
        if (this.#closed || connection.closed) return;
        response = {
          version: PROTOCOL_VERSION, projectId: this.#projectId, kind: "receipt", from: this.agentId, to: sender,
          receipt: {
            projectId: this.#projectId, messageId, from: this.agentId, to: sender,
            accepted: true, duplicate: false, receivedAt: new Date().toISOString(),
          },
        };
      } else {
        throw new Error("Unknown IPC request kind");
      }
      if (!this.#closed && !connection.closed) {
        if (connection.send(frame(response))) connection.end();
        else connection.destroy();
      }
    } catch (error) {
      if (this.#closed || connection.closed) return;
      const response: Response = {
        version: PROTOCOL_VERSION, projectId: this.#projectId, kind: "error", from: this.agentId, to: sender, error: errorMessage(error),
      };
      if (connection.send(frame(response))) connection.end();
      else connection.destroy();
    }
  }
}
