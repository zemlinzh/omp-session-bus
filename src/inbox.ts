import { createHash, randomBytes } from "node:crypto";
import type { AgentMessage } from "./protocol.js";

const MAX_RETAINED = 256;
const MAX_PAGE_ENTRIES = 32;
const MAX_PAGE_BYTES = 1024 * 1024;

export interface InboxEntry {
  sequence: number;
  message: AgentMessage;
  requiresReply: boolean;
}

export interface InboxPage {
  batchId: string;
  highWatermark: number;
  total: number;
  offset: number;
  nextOffset: number | null;
  entries: InboxEntry[];
}

export interface InboxStatus {
  unread: number;
  activeBatch: { batchId: string; highWatermark: number; total: number; read: number } | null;
  wakePending: boolean;
  admissionError: string | null;
}

interface InboxOptions {
  isPending: (messageId: string) => boolean;
  enqueueWake: (id: string) => Promise<void>;
  cancelWake: (id: string) => void;
  onError?: (error: Error) => void;
}

interface RetainedEntry extends InboxEntry {
  fingerprint: string;
  encodedBytes: number;
}

interface Batch {
  batchId: string;
  highWatermark: number;
  entries: RetainedEntry[];
  pageEnds: Map<number, number>;
  read: Set<number>;
}

function fingerprint(message: AgentMessage): string {
  // Protocol envelopes contain primitive fields. Fixed ordering also accepts an
  // identical envelope decoded with a different object property insertion order.
  return createHash("sha256").update(JSON.stringify([
    message.version, message.projectId, message.messageId, message.conversationId,
    message.from, message.to, message.inReplyTo, message.kind, message.text,
    message.turn, message.maxTurns, message.finished,
  ])).digest("hex");
}

/** One owned wake and one explicit, immutable receive-sequence batch at a time. */
export class BatchInbox {
  private readonly retained = new Map<string, RetainedEntry>();
  private readonly seen = new Map<string, string>();
  private sequence = 0;
  private activeBatch: Batch | null = null;
  private wakeId: string | null = null;
  private admissionError: string | null = null;
  private generation = 0;
  private disposed = false;

  constructor(private readonly options: InboxOptions) {}

  ensureCapacity(): void {
    this.requireActive();
    if (this.retained.size >= MAX_RETAINED) throw new Error("Inbox capacity reached (256 retained entries)");
  }

  receive(message: AgentMessage, requiresReply: boolean): void {
    this.requireActive();
    // Close controls carry no substantive work. The book applies cancellation
    // first; settlement only retires reply-required notifications.
    if (message.kind === "close") {
      this.settleRequests();
      return;
    }
    const digest = fingerprint(message);
    const previous = this.retained.get(message.messageId)?.fingerprint ?? this.seen.get(message.messageId);
    if (previous !== undefined) {
      if (previous !== digest) throw new Error("Message ID was reused with a different inbox envelope");
      return;
    }
    this.ensureCapacity();
    const entry: InboxEntry = { sequence: ++this.sequence, message: { ...message }, requiresReply };
    // `false` is one byte longer than `true`: settling a request must never move
    // a page boundary or make a previously bounded page exceed its byte budget.
    this.retained.set(message.messageId, {
      ...entry,
      fingerprint: digest,
      encodedBytes: Buffer.byteLength(JSON.stringify({ ...entry, requiresReply: false }), "utf8"),
    });
    this.seen.set(message.messageId, digest);
    // The ConversationBook owns full correlation/replay validation. Keep only
    // bounded recent digests here, in addition to all retained member digests.
    if (this.seen.size > MAX_RETAINED) this.seen.delete(this.seen.keys().next().value!);
    this.scheduleWake();
  }

  isWakePending(id: string): boolean {
    return !this.disposed && this.wakeId === id;
  }

  read(batchId?: string, offset = 0): InboxPage {
    this.requireActive();
    if (batchId !== undefined && batchId !== this.activeBatch?.batchId) throw new Error("Unknown inbox batch ID");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid inbox page offset");
    if (!this.activeBatch && offset !== 0) throw new Error("The first inbox page offset must be zero");

    const batch = this.activeBatch ?? this.createBatch();
    const end = batch.pageEnds.get(offset);
    if (end === undefined) throw new Error("Invalid inbox page offset; use a returned nextOffset");
    const entries: InboxEntry[] = [];
    for (let index = offset; index < end; index++) {
      const entry = batch.entries[index]!;
      entries.push({
        sequence: entry.sequence,
        message: { ...entry.message },
        requiresReply: entry.requiresReply && this.options.isPending(entry.message.messageId),
      });
    }
    if (!this.activeBatch) {
      // Only commit the new batch after every argument and page bound is valid.
      this.settleRequests();
      this.activeBatch = batch;
      this.admissionError = null;
      this.cancelOwnWake();
    }
    for (let index = offset; index < end; index++) batch.read.add(index);
    return {
      batchId: batch.batchId,
      highWatermark: batch.highWatermark,
      total: batch.entries.length,
      offset,
      nextOffset: end < batch.entries.length ? end : null,
      entries,
    };
  }

  complete(batchId: string): { batchId: string; consumed: number; remaining: number } {
    this.requireActive();
    const batch = this.activeBatch;
    if (!batch || batch.batchId !== batchId) throw new Error("Unknown or completed inbox batch ID");
    if (batch.read.size !== batch.entries.length) throw new Error("Read every inbox page before completing the batch");
    if (batch.entries.some(entry => entry.requiresReply && this.options.isPending(entry.message.messageId))) {
      throw new Error("Inbox batch still has pending formal replies");
    }
    for (const entry of batch.entries) this.retained.delete(entry.message.messageId);
    this.activeBatch = null;
    this.cancelOwnWake();
    this.settleRequests();
    const remaining = this.retained.size;
    this.scheduleWake();
    return { batchId, consumed: batch.entries.length, remaining };
  }

  settleRequests(): void {
    if (this.disposed) return;
    for (const [id, entry] of this.retained) {
      if (this.activeBatch && entry.sequence <= this.activeBatch.highWatermark) continue;
      if (entry.requiresReply && !this.options.isPending(id)) this.retained.delete(id);
    }
    if (this.retained.size === 0) this.cancelOwnWake();
  }

  status(): InboxStatus {
    const batch = this.activeBatch;
    return {
      unread: this.retained.size,
      activeBatch: batch ? {
        batchId: batch.batchId,
        highWatermark: batch.highWatermark,
        total: batch.entries.length,
        read: batch.read.size,
      } : null,
      wakePending: this.wakeId !== null,
      admissionError: this.admissionError,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.cancelOwnWake();
    this.retained.clear();
    this.seen.clear();
    this.activeBatch = null;
    this.admissionError = null;
  }

  private requireActive(): void {
    if (this.disposed) throw new Error("Inbox is disposed");
  }

  private createBatch(): Batch {
    const batch: Batch = {
      batchId: `inbox-batch-${randomBytes(16).toString("hex")}`,
      highWatermark: this.sequence,
      entries: Array.from(this.retained.values()).filter(entry => !entry.requiresReply || this.options.isPending(entry.message.messageId)),
      pageEnds: new Map(),
      read: new Set(),
    };
    if (batch.entries.length === 0) batch.pageEnds.set(0, 0);
    for (let offset = 0; offset < batch.entries.length;) {
      // null is longer than any next offset (at most 256), so this bounds the
      // complete encoded page, including its metadata, brackets and commas.
      let bytes = Buffer.byteLength(JSON.stringify({
        batchId: batch.batchId,
        highWatermark: batch.highWatermark,
        total: batch.entries.length,
        offset,
        nextOffset: null,
        entries: [],
      }), "utf8");
      let end = offset;
      while (end < batch.entries.length && end - offset < MAX_PAGE_ENTRIES) {
        const addedBytes = batch.entries[end]!.encodedBytes + (end > offset ? 1 : 0);
        if (bytes + addedBytes > MAX_PAGE_BYTES) break;
        bytes += addedBytes;
        end++;
      }
      if (end === offset) throw new Error("Inbox envelope exceeds the encoded page budget");
      batch.pageEnds.set(offset, end);
      offset = end;
    }
    return batch;
  }

  private scheduleWake(): void {
    if (this.disposed || this.activeBatch || this.wakeId !== null || this.admissionError !== null || this.retained.size === 0) return;
    const id = `inbox-wake-${randomBytes(16).toString("hex")}`;
    // Reserve before calling the adapter: normalization can await or reenter.
    this.wakeId = id;
    void this.admitWake(id, this.generation);
  }

  private async admitWake(id: string, generation: number): Promise<void> {
    try {
      await this.options.enqueueWake(id);
    } catch (error) {
      if (this.disposed || generation !== this.generation || this.wakeId !== id) return;
      this.admissionError = error instanceof Error ? error.message : String(error);
      this.cancelOwnWake();
      this.reportError(error);
    }
  }

  private cancelOwnWake(): void {
    const id = this.wakeId;
    if (id === null) return;
    this.wakeId = null;
    try {
      this.options.cancelWake(id);
    } catch (error) {
      this.admissionError = error instanceof Error ? error.message : String(error);
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // The status error remains visible even if the optional UI reporter fails.
    }
  }
}
