import { describe, expect, test } from "bun:test";
import { ConversationBook } from "../src/conversations.js";
import { BatchInbox } from "../src/inbox.js";
import { MAX_TEXT_BYTES, newConversationId, newMessageId, type AgentMessage } from "../src/protocol.js";

const A = "omp-0000000000000001";
const B = "omp-0000000000000002";
const PROJECT = "project-11111111111111111111111111111111";
const PAGE_BYTES = 1024 * 1024;

function terminal(text = "The final result"): AgentMessage {
  return {
    version: 2,
    projectId: PROJECT,
    messageId: newMessageId(),
    conversationId: newConversationId(),
    from: A,
    to: B,
    inReplyTo: newMessageId(),
    kind: "reply",
    text,
    turn: 1,
    maxTurns: 8,
    finished: true,
  };
}

function deferred() {
  return Promise.withResolvers<void>();
}

function fixture(book = new ConversationBook(B, PROJECT)) {
  const queued = new Set<string>();
  const wakes: string[] = [];
  const cancelled: string[] = [];
  const errors: Error[] = [];
  const inbox = new BatchInbox({
    isPending: id => book.hasPendingMessage(id),
    enqueueWake: async id => { wakes.push(id); queued.add(id); },
    cancelWake: id => { cancelled.push(id); queued.delete(id); },
    onError: error => { errors.push(error); },
  });
  return { inbox, book, queued, wakes, cancelled, errors };
}

function accept(book: ConversationBook, inbox: BatchInbox, message: AgentMessage) {
  const result = book.receive(message);
  if (message.kind === "close") inbox.settleRequests();
  else if (result !== "duplicate") inbox.receive(message, result === "request");
  return result;
}

describe("BatchInbox correlated consumer batches", () => {
  test("twenty finals and requests create one wake and preserve every original envelope", () => {
    const { inbox, book, wakes, queued } = fixture();
    const peer = new ConversationBook(A, PROJECT);
    const originals: AgentMessage[] = [];
    for (let index = 0; index < 20; index++) {
      if (index % 2 === 0) {
        const outgoing = book.start(A, `Question ${index}`, 4);
        peer.receive(outgoing);
        const message = peer.reply(outgoing.messageId, `Distinct final ${index}`, true);
        expect(accept(book, inbox, message)).toBe("terminal");
        originals.push(message);
      } else {
        const message = peer.start(B, `Distinct request ${index}`, 6);
        expect(accept(book, inbox, message)).toBe("request");
        originals.push(message);
      }
    }
    expect(wakes).toHaveLength(1);
    expect(inbox.isWakePending(wakes[0]!)).toBe(true);
    expect(inbox.status()).toEqual({ unread: 20, activeBatch: null, wakePending: true, admissionError: null });
    const page = inbox.read();
    expect(page.total).toBe(20);
    expect(page.highWatermark).toBe(20);
    expect(page.offset).toBe(0);
    expect(page.nextOffset).toBeNull();
    expect(page.entries.map(entry => entry.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(page.entries.map(entry => entry.message)).toEqual(originals);
    expect(page.entries.map(entry => entry.requiresReply)).toEqual(Array.from({ length: 20 }, (_, index) => index % 2 === 1));
    expect(new Set(originals.flatMap(message => [message.messageId, message.conversationId])).has(page.batchId)).toBe(false);
    expect(queued.size).toBe(0);
    expect(inbox.isWakePending(wakes[0]!)).toBe(false);
    expect(() => inbox.complete(page.batchId)).toThrow(/pending|reply/i);
    for (const entry of page.entries) {
      if (!entry.requiresReply) continue;
      const reply = book.reply(entry.message.messageId, `Answer ${entry.sequence}`, true);
      expect(reply.inReplyTo).toBe(entry.message.messageId);
      expect(reply.conversationId).toBe(entry.message.conversationId);
      expect(reply.from).toBe(B);
      expect(reply.to).toBe(A);
      expect(reply.maxTurns).toBe(entry.message.maxTurns);
    }
    inbox.settleRequests();
    expect(inbox.read(page.batchId).entries.every(entry => !entry.requiresReply)).toBe(true);
    expect(inbox.complete(page.batchId)).toEqual({ batchId: page.batchId, consumed: 20, remaining: 0 });
    expect(inbox.status().unread).toBe(0);
    expect(wakes).toHaveLength(1);
  });

  test("requires all pages to be read and defers arrivals until exact batch completion", () => {
    const { inbox, wakes } = fixture();
    const originals = Array.from({ length: 70 }, (_, index) => terminal(`Result ${index}`));
    for (const message of originals) inbox.receive(message, false);
    const first = inbox.read();
    expect(first.entries).toHaveLength(32);
    expect(first.nextOffset).toBe(32);
    expect(first.total).toBe(70);
    expect(first.highWatermark).toBe(70);
    const later = terminal("Arrived while handling the first batch");
    inbox.receive(later, false);
    expect(wakes).toHaveLength(1);
    expect(inbox.read()).toEqual(first);
    expect(inbox.status().activeBatch).toEqual({ batchId: first.batchId, highWatermark: 70, total: 70, read: 32 });
    expect(() => inbox.complete(first.batchId)).toThrow(/read|page/i);
    const second = inbox.read(first.batchId, first.nextOffset!);
    expect(second.entries).toHaveLength(32);
    expect(second.nextOffset).toBe(64);
    expect(second.highWatermark).toBe(70);
    expect(() => inbox.complete(first.batchId)).toThrow(/read|page/i);
    const last = inbox.read(first.batchId, second.nextOffset!);
    expect(last.entries).toHaveLength(6);
    expect(last.nextOffset).toBeNull();
    expect([...first.entries, ...second.entries, ...last.entries].map(entry => entry.message)).toEqual(originals);
    expect(inbox.complete(first.batchId)).toEqual({ batchId: first.batchId, consumed: 70, remaining: 1 });
    expect(wakes).toHaveLength(2);
    expect(wakes[1]).not.toBe(wakes[0]);
    const next = inbox.read();
    expect(next.batchId).not.toBe(first.batchId);
    expect(next.highWatermark).toBe(71);
    expect(next.entries).toEqual([{ sequence: 71, message: later, requiresReply: false }]);
    expect(() => inbox.complete(first.batchId)).toThrow(/batch/i);
    expect(inbox.status().activeBatch?.batchId).toBe(next.batchId);
    expect(inbox.complete(next.batchId).consumed).toBe(1);
  });

  test("rejects unknown batch IDs and invalid offsets without consuming or creating a batch", () => {
    const { inbox, wakes, cancelled } = fixture();
    const message = terminal();
    inbox.receive(message, false);
    const initial = inbox.status();
    for (const id of ["missing", "", message.messageId, message.conversationId]) {
      expect(() => inbox.read(id)).toThrow(/batch/i);
      expect(() => inbox.complete(id)).toThrow(/batch/i);
      expect(inbox.status()).toEqual(initial);
    }
    for (const offset of [-1, 0.5, NaN, Infinity, 1, Number.MAX_SAFE_INTEGER]) {
      expect(() => inbox.read(undefined, offset)).toThrow(/offset/i);
      expect(inbox.status()).toEqual(initial);
    }
    expect(cancelled).toEqual([]);
    expect(inbox.isWakePending(wakes[0]!)).toBe(true);
    const page = inbox.read();
    const reading = inbox.status();
    expect(() => inbox.read("wrong", 0)).toThrow(/batch/i);
    expect(() => inbox.read(page.batchId, page.total)).toThrow(/offset/i);
    expect(inbox.status()).toEqual(reading);
    expect(inbox.complete(page.batchId).consumed).toBe(1);
    expect(() => inbox.read(page.batchId)).toThrow(/batch/i);
    expect(() => inbox.complete(page.batchId)).toThrow(/batch/i);
    expect(inbox.status().activeBatch).toBeNull();
  });

  test("empty batches have unique IDs and can be completed only once", () => {
    const { inbox, wakes } = fixture();
    const first = inbox.read();
    expect(first).toEqual({ batchId: first.batchId, highWatermark: 0, total: 0, offset: 0, nextOffset: null, entries: [] });
    expect(inbox.read()).toEqual(first);
    expect(inbox.complete(first.batchId)).toEqual({ batchId: first.batchId, consumed: 0, remaining: 0 });
    expect(() => inbox.complete(first.batchId)).toThrow(/batch/i);
    const second = inbox.read();
    expect(second.batchId).not.toBe(first.batchId);
    expect(wakes).toEqual([]);
    inbox.complete(second.batchId);
  });

  test("preserves successive nonterminal replies from the same conversation in separate batches", () => {
    const { inbox, book, wakes } = fixture();
    const peer = new ConversationBook(A, PROJECT);
    const request = peer.start(B, "Discuss in multiple turns", 6);
    accept(book, inbox, request);
    const first = inbox.read();
    const response = book.reply(request.messageId, "First formal response");
    peer.receive(response);
    const followup = peer.reply(response.messageId, "The correlated follow-up");
    expect(accept(book, inbox, followup)).toBe("request");
    inbox.settleRequests();
    expect(inbox.read(first.batchId).entries).toEqual([{ sequence: 1, message: request, requiresReply: false }]);
    expect(inbox.complete(first.batchId)).toEqual({ batchId: first.batchId, consumed: 1, remaining: 1 });
    expect(wakes).toHaveLength(2);
    const second = inbox.read();
    expect(second.batchId).not.toBe(first.batchId);
    expect(second.entries).toEqual([{ sequence: 2, message: followup, requiresReply: true }]);
    expect(second.entries[0]!.message.conversationId).toBe(request.conversationId);
    expect(second.entries[0]!.message.inReplyTo).toBe(response.messageId);
    expect(second.entries[0]!.message.turn).toBe(2);
    expect(() => inbox.complete(second.batchId)).toThrow(/pending|reply/i);
    book.reply(followup.messageId, "Final response", true);
    expect(inbox.complete(second.batchId).consumed).toBe(1);
  });

  test("bounds encoded UTF8 pages without truncating a maximum escaped message", () => {
    const { inbox } = fixture();
    const escaped = terminal("\u0000".repeat(MAX_TEXT_BYTES));
    const unicode = terminal("界".repeat(40_000));
    const originals = [escaped, escaped, unicode, terminal("last")].map(message => ({ ...message, messageId: newMessageId() }));
    for (const message of originals) inbox.receive(message, false);
    const first = inbox.read();
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]!.message.text.length).toBe(MAX_TEXT_BYTES);
    expect(first.entries[0]!.message.text).toBe(originals[0]!.text);
    expect(first.nextOffset).toBe(1);
    const second = inbox.read(first.batchId, first.nextOffset!);
    expect(second.entries).toHaveLength(3);
    expect(second.nextOffset).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(PAGE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(second), "utf8")).toBeLessThanOrEqual(PAGE_BYTES);
    expect([...first.entries, ...second.entries].map(entry => entry.message)).toEqual(originals);
    expect(inbox.complete(first.batchId).consumed).toBe(4);
  });

  test("isolates stored envelopes and read tracking from caller mutations", () => {
    const { inbox } = fixture();
    const original = terminal("Keep the exact original text");
    const expected = { ...original };
    inbox.receive(original, false);
    original.text = "Changed after receipt";
    original.conversationId = newConversationId();
    const page = inbox.read();
    expect(page.entries[0]!.message).toEqual(expected);
    page.entries[0]!.message.text = "Changed after read";
    page.entries[0]!.message.messageId = newMessageId();
    page.entries[0]!.requiresReply = true;
    page.entries[0]!.sequence = -1;
    page.entries.length = 0;
    const status = inbox.status();
    status.activeBatch!.read = 0;
    expect(inbox.read(page.batchId).entries).toEqual([{ sequence: 1, message: expected, requiresReply: false }]);
    expect(inbox.complete(page.batchId).consumed).toBe(1);
  });

  test("ignores only exact duplicate envelopes without replacing retained content or reviving consumed work", () => {
    const { inbox, wakes } = fixture();
    const message = terminal("Original answer");
    inbox.receive(message, false);
    inbox.receive({ ...message }, true);
    const reordered = Object.fromEntries(Object.entries(message).reverse()) as unknown as AgentMessage;
    inbox.receive(reordered, false);
    for (const change of [
      { text: "Changed text" }, { conversationId: newConversationId() }, { projectId: "project-22222222222222222222222222222222" },
      { from: "omp-0000000000000003" }, { to: "omp-0000000000000004" }, { inReplyTo: newMessageId() },
      { turn: 2 }, { maxTurns: 9 }, { finished: false }, { kind: "message" as const }, { version: 1 as unknown as 2 },
    ]) {
      expect(() => inbox.receive({ ...message, ...change }, false)).toThrow(/envelope|duplicate|reused/i);
    }
    expect(inbox.status().unread).toBe(1);
    const page = inbox.read();
    expect(page.entries).toEqual([{ sequence: 1, message, requiresReply: false }]);
    inbox.complete(page.batchId);
    inbox.receive({ ...message }, false);
    expect(inbox.status().unread).toBe(0);
    expect(wakes).toHaveLength(1);
  });

  test("enforces retained capacity even after pages are read and permits exact duplicates at capacity", () => {
    const { inbox } = fixture();
    const originals = Array.from({ length: 256 }, (_, index) => terminal(`Retained ${index}`));
    for (const message of originals) { inbox.ensureCapacity(); inbox.receive(message, false); }
    expect(() => inbox.ensureCapacity()).toThrow(/capacity/i);
    expect(() => inbox.receive(terminal("Overflow"), false)).toThrow(/capacity/i);
    expect(() => inbox.receive({ ...originals[0]! }, false)).not.toThrow();
    const page = inbox.read();
    expect(() => inbox.ensureCapacity()).toThrow(/capacity/i);
    for (let offset = 32; offset < 256; offset += 32) inbox.read(page.batchId, offset);
    expect(inbox.status().unread).toBe(256);
    expect(inbox.complete(page.batchId).consumed).toBe(256);
    expect(() => inbox.ensureCapacity()).not.toThrow();
    const nextMessage = terminal("Accepted after completion");
    inbox.receive(nextMessage, false);
    expect(inbox.read().entries).toEqual([{ sequence: 257, message: nextMessage, requiresReply: false }]);
  });
});

describe("BatchInbox cancellation and request settlement", () => {
  test("settles answered and stopped requests but retains unread terminal replies after close", () => {
    const { inbox, book, wakes, queued } = fixture();
    const peer = new ConversationBook(A, PROJECT);
    const answered = peer.start(B, "Reply manually");
    const stopped = peer.start(B, "Cancel this thread");
    accept(book, inbox, answered);
    accept(book, inbox, stopped);
    const outgoing = book.start(A, "Return final");
    peer.receive(outgoing);
    const final = peer.reply(outgoing.messageId, "Unread final survives close", true);
    accept(book, inbox, final);
    book.reply(answered.messageId, "Manual answer", true);
    const close = peer.stop(stopped.conversationId)!;
    expect(accept(book, inbox, close)).toBe("terminal");
    expect(inbox.status().unread).toBe(1);
    expect(queued.size).toBe(1);
    expect(wakes).toHaveLength(1);
    const page = inbox.read();
    expect(page.entries).toEqual([{ sequence: 3, message: final, requiresReply: false }]);
    expect(inbox.complete(page.batchId).consumed).toBe(1);
  });

  test("cancelled active members retain page identities and must still be read before completion", () => {
    const { inbox, book, wakes } = fixture();
    const peer = new ConversationBook(A, PROJECT);
    const requests = Array.from({ length: 40 }, (_, index) => peer.start(B, `Request ${index}`));
    for (const request of requests) accept(book, inbox, request);
    const first = inbox.read();
    expect(first.nextOffset).toBe(32);
    book.closeAll("Session interrupted");
    inbox.settleRequests();
    const repeated = inbox.read(first.batchId);
    expect(repeated.batchId).toBe(first.batchId);
    expect(repeated.highWatermark).toBe(40);
    expect(repeated.total).toBe(40);
    expect(repeated.nextOffset).toBe(32);
    expect(repeated.entries.map(entry => entry.message)).toEqual(requests.slice(0, 32));
    expect(repeated.entries.every(entry => !entry.requiresReply)).toBe(true);
    expect(() => inbox.complete(first.batchId)).toThrow(/read|page/i);
    const last = inbox.read(first.batchId, 32);
    expect(last.entries.map(entry => entry.message)).toEqual(requests.slice(32));
    expect(last.entries.every(entry => !entry.requiresReply)).toBe(true);
    expect(inbox.complete(first.batchId).consumed).toBe(40);
    expect(wakes).toHaveLength(1);
  });

  test("settlement removes deferred settled requests without altering the active batch", () => {
    const { inbox, book, wakes } = fixture();
    const peer = new ConversationBook(A, PROJECT);
    const final = terminal();
    inbox.receive(final, false);
    const page = inbox.read();
    const deferredRequest = peer.start(B, "Arrived after the first read");
    accept(book, inbox, deferredRequest);
    book.fail(deferredRequest.conversationId);
    inbox.settleRequests();
    expect(inbox.read(page.batchId)).toEqual(page);
    expect(inbox.complete(page.batchId)).toEqual({ batchId: page.batchId, consumed: 1, remaining: 0 });
    expect(wakes).toHaveLength(1);
  });

  test("cancels the exact owned marker when every request settles and close controls never wake", () => {
    const { inbox, book, wakes, cancelled, queued } = fixture();
    const peer = new ConversationBook(A, PROJECT);
    const request = peer.start(B, "Cancel before reading");
    accept(book, inbox, request);
    queued.add("unrelated-user-notification");
    const close = peer.stop(request.conversationId)!;
    book.receive(close);
    inbox.receive(close, false);
    inbox.settleRequests();
    expect(inbox.status().unread).toBe(0);
    expect(inbox.status().wakePending).toBe(false);
    expect(cancelled).toEqual([wakes[0]!]);
    expect([...queued]).toEqual(["unrelated-user-notification"]);
    const empty = inbox.read();
    expect(empty.total).toBe(0);
    inbox.complete(empty.batchId);
    expect(wakes).toHaveLength(1);
  });
});

describe("BatchInbox asynchronous wake admission", () => {
  test("reserves one live wake synchronously before asynchronous admission and reentrant receipt", async () => {
    const gate = deferred();
    const wakes: string[] = [];
    let inbox!: BatchInbox;
    inbox = new BatchInbox({
      isPending: () => false,
      enqueueWake: async id => {
        wakes.push(id);
        expect(inbox.isWakePending(id)).toBe(true);
        if (wakes.length === 1) inbox.receive(terminal("Reentrant receipt"), false);
        await gate.promise;
      },
      cancelWake: () => {},
    });
    inbox.receive(terminal("First receipt"), false);
    for (let index = 0; index < 20; index++) inbox.receive(terminal(`While normalizing ${index}`), false);
    expect(wakes).toHaveLength(1);
    expect(inbox.status().unread).toBe(22);
    gate.resolve();
    await gate.promise;
    expect(wakes).toHaveLength(1);
    const page = inbox.read();
    expect(page.entries[0]!.message.text).toBe("First receipt");
    expect(page.entries[1]!.message.text).toBe("Reentrant receipt");
    expect(inbox.complete(page.batchId).consumed).toBe(22);
  });

  test("manual reading before admission prevents the late marker from becoming live", async () => {
    const gate = deferred();
    const admitted: string[] = [];
    const wakes: string[] = [];
    const cancelled: string[] = [];
    let inbox!: BatchInbox;
    inbox = new BatchInbox({
      isPending: () => false,
      enqueueWake: async id => {
        wakes.push(id);
        await gate.promise;
        if (inbox.isWakePending(id)) admitted.push(id);
      },
      cancelWake: id => { cancelled.push(id); },
    });
    inbox.receive(terminal(), false);
    const page = inbox.read();
    inbox.receive(terminal("Deferred until completion"), false);
    gate.resolve();
    await gate.promise;
    await Promise.resolve();
    expect(admitted).toEqual([]);
    expect(cancelled).toContain(wakes[0]!);
    expect(inbox.status().activeBatch?.batchId).toBe(page.batchId);
    inbox.complete(page.batchId);
    await Promise.resolve();
    expect(wakes).toHaveLength(2);
    expect(inbox.isWakePending(wakes[1]!)).toBe(true);
  });

  test("admission errors remain visible without retries until an explicit read recovers unread data", async () => {
    const gate = deferred();
    const wakes: string[] = [];
    const cancelled: string[] = [];
    const errors: Error[] = [];
    const inbox = new BatchInbox({
      isPending: () => false,
      enqueueWake: id => { wakes.push(id); return gate.promise; },
      cancelWake: id => { cancelled.push(id); },
      onError: error => { errors.push(error); },
    });
    inbox.receive(terminal("First retained result"), false);
    gate.reject(new Error("Normalization failed"));
    await gate.promise.catch(() => {});
    await Promise.resolve();
    expect(inbox.status().admissionError).toBe("Normalization failed");
    expect(inbox.status().wakePending).toBe(false);
    expect(inbox.status().unread).toBe(1);
    expect(errors.map(error => error.message)).toEqual(["Normalization failed"]);
    expect(cancelled).toEqual([wakes[0]!]);
    inbox.receive(terminal("Still retained without retry"), false);
    inbox.settleRequests();
    expect(wakes).toHaveLength(1);
    const page = inbox.read();
    expect(page.entries.map(entry => entry.message.text)).toEqual(["First retained result", "Still retained without retry"]);
    expect(inbox.status().admissionError).toBeNull();
    expect(inbox.complete(page.batchId).consumed).toBe(2);
  });

  test("a late failed old admission cannot poison a newer batch marker", async () => {
    const oldGate = deferred();
    const wakes: string[] = [];
    const errors: Error[] = [];
    const inbox = new BatchInbox({
      isPending: () => false,
      enqueueWake: id => { wakes.push(id); return wakes.length === 1 ? oldGate.promise : Promise.resolve(); },
      cancelWake: () => {},
      onError: error => { errors.push(error); },
    });
    inbox.receive(terminal("First batch"), false);
    const first = inbox.read();
    inbox.receive(terminal("Next batch"), false);
    inbox.complete(first.batchId);
    expect(wakes).toHaveLength(2);
    oldGate.reject(new Error("Late old error"));
    await oldGate.promise.catch(() => {});
    await Promise.resolve();
    expect(inbox.status().admissionError).toBeNull();
    expect(inbox.isWakePending(wakes[1]!)).toBe(true);
    expect(errors).toEqual([]);
    const second = inbox.read();
    expect(second.entries[0]!.message.text).toBe("Next batch");
    inbox.complete(second.batchId);
  });

  test("synchronous admission failure and throwing error reporters do not lose unread entries", async () => {
    let attempts = 0;
    const inbox = new BatchInbox({
      isPending: () => false,
      enqueueWake: () => { attempts++; throw new Error("Cannot admit"); },
      cancelWake: () => {},
      onError: () => { throw new Error("Cannot report"); },
    });
    expect(() => inbox.receive(terminal("Recover me"), false)).not.toThrow();
    await Promise.resolve();
    expect(inbox.status().admissionError).toBe("Cannot admit");
    expect(inbox.status().unread).toBe(1);
    inbox.receive(terminal("Recover me too"), false);
    expect(attempts).toBe(1);
    const page = inbox.read();
    expect(page.total).toBe(2);
    expect(inbox.complete(page.batchId).consumed).toBe(2);
  });

  test("disposal abandons only transient inbox state and never changes the conversation book", () => {
    const { inbox, book } = fixture();
    const peer = new ConversationBook(A, PROJECT);
    const request = peer.start(B, "Still pending in the owning book");
    accept(book, inbox, request);
    const page = inbox.read();
    inbox.receive(terminal("Deferred old-session final"), false);
    inbox.dispose();
    expect(book.pending()).toEqual([request]);
    expect(inbox.status()).toEqual({ unread: 0, activeBatch: null, wakePending: false, admissionError: null });
    expect(() => inbox.complete(page.batchId)).toThrow(/disposed/i);
    inbox.settleRequests();
    expect(book.pending()).toEqual([request]);
  });

  test.each(["resolve", "reject"] as const)("dispose fences a late admission %s and all future scheduling", async outcome => {
    const gate = deferred();
    const wakes: string[] = [];
    const admitted: string[] = [];
    const cancelled: string[] = [];
    const errors: Error[] = [];
    let inbox!: BatchInbox;
    inbox = new BatchInbox({
      isPending: () => false,
      enqueueWake: async id => { wakes.push(id); await gate.promise; if (inbox.isWakePending(id)) admitted.push(id); },
      cancelWake: id => { cancelled.push(id); },
      onError: error => { errors.push(error); },
    });
    inbox.receive(terminal("Old session"), false);
    inbox.dispose();
    inbox.dispose();
    inbox.settleRequests();
    expect(inbox.isWakePending(wakes[0]!)).toBe(false);
    expect(cancelled).toEqual([wakes[0]!]);
    expect(() => inbox.receive(terminal(), false)).toThrow(/disposed/i);
    expect(() => inbox.ensureCapacity()).toThrow(/disposed/i);
    expect(() => inbox.read()).toThrow(/disposed/i);
    expect(() => inbox.complete("old")).toThrow(/disposed/i);
    if (outcome === "resolve") gate.resolve();
    else gate.reject(new Error("Late disposed failure"));
    await gate.promise.catch(() => {});
    await Promise.resolve();
    expect(admitted).toEqual([]);
    expect(errors).toEqual([]);
    expect(wakes).toHaveLength(1);
    expect(inbox.status()).toEqual({ unread: 0, activeBatch: null, wakePending: false, admissionError: null });
  });
});
