import { describe, expect, test } from "bun:test";
import { Agent, type AgentMessage as QueuedMessage, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { createAssistantMessageEventStream, type as schema, type AssistantMessage, type Context, type Message, type ToolCall } from "@oh-my-pi/pi-ai";
import { ConversationBook } from "../src/conversations.js";
import { BatchInbox, type InboxEntry, type InboxPage } from "../src/inbox.js";
import type { AgentMessage } from "../src/protocol.js";
import { QueuedPeerPrompts, type QueuedPromptHost } from "../src/queued-prompts.js";

const LOCAL = "omp-0000000000000001";
const PEER = "omp-0000000000000002";
const PROJECT = "project-11111111111111111111111111111111";
const WAKE = "Read the session_inbox batch: ";
const STOP: AssistantMessage["content"] = [{ type: "text", text: "Batch processing finished." }];

interface Admission {
  normalize: PromiseWithResolvers<void>;
  queued: PromiseWithResolvers<void>;
  finish: PromiseWithResolvers<void>;
  messages: QueuedMessage[];
}

/** Only provider output and asynchronous host normalization are controlled.
 * Queue storage, claims, dequeue, tool execution and abort recovery are native. */
class BatchHost implements QueuedPromptHost {
  isStreaming = true;
  readonly admissions: Admission[] = [];
  readonly providerInputs: Message[][] = [];
  respond: (context: Context) => AssistantMessage["content"] = () => STOP;
  readonly agent: Agent;

  constructor() {
    const streamFn: StreamFn = (model, context) => {
      this.providerInputs.push(structuredClone(context.messages));
      const content = this.respond(context);
      const stopReason = content.some(part => part.type === "toolCall") ? "toolUse" : "stop";
      const message: AssistantMessage = {
        role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason, timestamp: 0,
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: stopReason, message });
      stream.end();
      return stream;
    };
    this.agent = new Agent({
      // Deliberately omit steeringMode/followUpMode: both native defaults must
      // stay one-at-a-time. Setting "all" would hide per-envelope wakeups.
      streamFn,
      convertToLlm: messages => {
        const converted: Message[] = [];
        for (const message of messages) {
          if (message.role === "custom") {
            converted.push({ role: "user", content: message.content, attribution: message.attribution, timestamp: message.timestamp });
          } else if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
            converted.push(message);
          }
        }
        return converted;
      },
    });
  }

  promptCustomMessage: QueuedPromptHost["promptCustomMessage"] = async (payload, options) => {
    const admission: Admission = {
      normalize: Promise.withResolvers<void>(), queued: Promise.withResolvers<void>(), finish: Promise.withResolvers<void>(), messages: [],
    };
    this.admissions.push(admission);
    await admission.normalize.promise;
    if (!options?.queueOnly || options.streamingBehavior !== "followUp") {
      throw new Error("Batch notifications must use cancellable queue-only follow-up admission");
    }
    const custom: QueuedMessage = { ...payload, role: "custom", timestamp: 0 };
    admission.messages = [custom];
    this.agent.followUp(custom);
    options.onPromptQueued?.(admission.messages);
    admission.queued.resolve();
    await admission.finish.promise;
    return true;
  };

  async admit(index = this.admissions.length - 1): Promise<Admission> {
    const admission = this.admissions[index];
    admission.normalize.resolve();
    await admission.queued.promise;
    return admission;
  }

  pending(): readonly QueuedMessage[] {
    return [...this.agent.peekSteeringQueue(), ...this.agent.peekFollowUpQueue()];
  }
}

function user(content: string): QueuedMessage {
  return { role: "user", content, timestamp: 0 };
}

function isWake(message: QueuedMessage): boolean {
  return message.role === "custom" && message.customType === "session-bus-inbox";
}

function expectDefaultModes(host: BatchHost): void {
  expect(host.agent.getFollowUpMode()).toBe("one-at-a-time");
  expect(host.agent.getSteeringMode()).toBe("one-at-a-time");
}

function fixture(host = new BatchHost()) {
  const book = new ConversationBook(LOCAL, PROJECT);
  const peer = new ConversationBook(PEER, PROJECT);
  const deliveries: Promise<void>[] = [];
  const admissionErrors: Error[] = [];
  const replies: AgentMessage[] = [];
  let inbox: BatchInbox;
  const queue = new QueuedPeerPrompts(host, id => inbox.isWakePending(id));
  inbox = new BatchInbox({
    isPending: id => book.hasPendingMessage(id),
    enqueueWake: id => {
      // The queue adapter only uses these internal registration identities;
      // this envelope never enters a ConversationBook or the wire protocol.
      const registration: AgentMessage = {
        version: 2, projectId: PROJECT, messageId: id, conversationId: id,
        from: PEER, to: LOCAL, inReplyTo: null, kind: "message", text: "Inbox available",
        turn: 0, maxTurns: 8, finished: false,
      };
      const delivery = queue.submit(registration, {
        customType: "session-bus-inbox", content: `${WAKE}${id}`, attribution: "agent", display: true,
        details: { wakeId: id },
      });
      deliveries.push(delivery);
      return delivery;
    },
    cancelWake: id => queue.cancelMessage(id),
    onError: error => admissionErrors.push(error),
  });

  const receive = (message: AgentMessage) => {
    const result = book.receive(message);
    if (result !== "duplicate" && message.kind !== "close") inbox.receive(message, result === "request");
    if (message.kind === "close") inbox.settleRequests();
    return result;
  };
  const request = (text: string, maxTurns = 8) => {
    const message = peer.start(LOCAL, text, maxTurns);
    receive(message);
    return message;
  };
  const finalReply = (text: string, maxTurns = 8) => {
    const outgoing = book.start(PEER, `Original request for ${text}`, maxTurns);
    peer.receive(outgoing);
    const message = peer.reply(outgoing.messageId, text, true);
    receive(message);
    return message;
  };
  const reply = (replyTo: string, text = "Handled the exact requested item") => {
    const message = book.reply(replyTo, text, true);
    peer.receive(message);
    replies.push(message);
    inbox.settleRequests();
    return message;
  };
  const finishAdmission = async (index = host.admissions.length - 1) => {
    const admission = await host.admit(index);
    admission.finish.resolve();
    await deliveries[index];
    return admission;
  };
  const dispose = () => {
    inbox.dispose();
    queue.dispose();
    for (const admission of host.admissions) {
      admission.normalize.resolve();
      admission.finish.resolve();
    }
  };
  return { host, book, peer, inbox, queue, deliveries, admissionErrors, replies, receive, request, finalReply, reply, finishAdmission, dispose };
}

interface ConsumerFixture {
  host: BatchHost;
  inbox: BatchInbox;
  reply(replyTo: string, text?: string): AgentMessage;
}

interface Completion {
  batchId: string;
  consumed: number;
  remaining: number;
}

/** A deterministic provider reads only real tool-result JSON. It cannot peek
 * into the inbox, finish requests itself, or remove a native queued message. */
function installBatchConsumer(f: ConsumerFixture, onRead?: (page: InboxPage) => void) {
  const pages: InboxPage[] = [];
  const completions: Completion[] = [];
  const readSchema = schema({ action: "'read' | 'complete'", "batchId?": "string", "offset?": "number" });
  const replySchema = schema({ replyTo: "string", text: "string", done: "boolean" });
  const inboxTool: AgentTool<typeof readSchema> = {
    name: "session_inbox", label: "Inbox", description: "Read or complete one immutable inbox batch", parameters: readSchema,
    execute: async (_id, args) => {
      if (args.action === "read") {
        const page = f.inbox.read(args.batchId, args.offset);
        pages.push(structuredClone(page));
        onRead?.(page);
        return { content: [{ type: "text", text: JSON.stringify(page) }] };
      }
      if (!args.batchId) throw new Error("Completion requires an exact batch ID");
      const completion = f.inbox.complete(args.batchId);
      completions.push(completion);
      return { content: [{ type: "text", text: JSON.stringify(completion) }] };
    },
  };
  const replyTool: AgentTool<typeof replySchema> = {
    name: "session_reply", label: "Reply", description: "Reply to an exact pending peer message", parameters: replySchema,
    execute: async (_id, args) => {
      if (!args.done) throw new Error("This consumer explicitly finishes each request");
      const message = f.reply(args.replyTo, args.text);
      return { content: [{ type: "text", text: JSON.stringify(message) }] };
    },
  };
  f.host.agent.setTools([inboxTool, replyTool]);
  let callId = 0;
  let current: InboxPage | undefined;
  let entries: InboxEntry[] = [];
  const call = (name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id: `batch-call-${++callId}`, name, arguments: args });
  f.host.respond = context => {
    const last = context.messages.at(-1);
    if (last?.role === "user" && typeof last.content === "string" && last.content.startsWith(WAKE)) {
      entries = [];
      current = undefined;
      return [call("session_inbox", { action: "read" })];
    }
    if (last?.role !== "toolResult" || last.isError) return STOP;
    if (last.toolName === "session_inbox") {
      const part = last.content.find(part => part.type === "text");
      if (!part || part.type !== "text") return STOP;
      const result = JSON.parse(part.text) as InboxPage | Completion;
      if (!("entries" in result)) return STOP;
      current = result;
      entries.push(...result.entries);
      if (result.nextOffset !== null) return [call("session_inbox", { action: "read", batchId: result.batchId, offset: result.nextOffset })];
      const pending = entries.filter(entry => entry.requiresReply).reverse();
      if (pending.length) return pending.map(entry => call("session_reply", {
        replyTo: entry.message.messageId, text: `Exact answer for ${entry.message.text}`, done: true,
      }));
      return [call("session_inbox", { action: "complete", batchId: result.batchId })];
    }
    if (last.toolName === "session_reply" && current) return [call("session_inbox", { action: "complete", batchId: current.batchId })];
    return STOP;
  };
  return { pages, completions };
}

function expectSuccessfulTools(host: BatchHost): void {
  expect(host.agent.state.messages.filter(message => message.role === "toolResult" && message.isError)).toEqual([]);
  expect(host.agent.state.error).toBeUndefined();
}

describe("batch inbox delivery through native one-at-a-time Agent queues", () => {
  for (const requestCount of [0, 20]) {
    test(`20 exact final replies plus ${requestCount} requests use one wake and one completed batch`, async () => {
      const f = fixture();
      try {
        const expected: AgentMessage[] = [];
        for (let index = 0; index < 20; index++) {
          // Same business labels and out-of-order revision text are intentionally
          // not a dedup key; every original correlation must survive.
          expected.push(structuredClone(f.finalReply(`Result ${index}: revision ${20 - index}, same work item; 完成\n"exact"\\body`, index % 2 ? 8 : 16)));
          if (requestCount) expected.push(structuredClone(f.request(`Request ${index}: inspect the same work item; 原文\n${index}`, index % 2 ? 7 : 13)));
        }
        expectDefaultModes(f.host);
        expect(f.host.admissions).toHaveLength(1);
        expect(f.host.pending()).toEqual([]);
        const consumer = installBatchConsumer(f);
        const admission = await f.finishAdmission();
        expect(f.host.agent.peekFollowUpQueue()).toEqual(admission.messages);
        expect(f.host.pending()).toHaveLength(1);
        expect(admission.messages[0]).toMatchObject({ role: "custom", customType: "session-bus-inbox", attribution: "agent", display: true });
        const markerSnapshot = structuredClone(admission.messages[0]);
        Object.freeze(admission.messages[0]);
        await f.host.agent.continue();

        const readEntries = consumer.pages.flatMap(page => page.entries);
        expect(readEntries.map(entry => entry.message)).toEqual(expected);
        expect(readEntries.map(entry => entry.sequence)).toEqual(expected.map((_, index) => index + 1));
        expect(readEntries.map(entry => entry.requiresReply)).toEqual(expected.map(message => message.kind === "message"));
        expect(consumer.pages.map(page => page.entries.length)).toEqual(requestCount ? [32, 8] : [20]);
        const batchId = consumer.pages[0].batchId;
        expect(consumer.pages.every(page => page.batchId === batchId && page.total === expected.length && page.highWatermark === expected.length)).toBe(true);
        expect(expected.some(message => message.messageId === batchId || message.conversationId === batchId)).toBe(false);
        expect(consumer.completions).toEqual([{ batchId, consumed: expected.length, remaining: 0 }]);
        expect(f.replies.map(message => message.inReplyTo).sort()).toEqual(expected.filter(message => message.kind === "message").map(message => message.messageId).sort());
        for (const response of f.replies) {
          const original = expected.find(message => message.messageId === response.inReplyTo)!;
          expect(response).toMatchObject({ projectId: PROJECT, conversationId: original.conversationId, from: LOCAL, to: PEER, turn: original.turn + 1, maxTurns: original.maxTurns, finished: true });
        }
        expect(f.book.pending()).toEqual([]);
        expect(f.peer.pending()).toEqual([]);
        expect(f.book.list().every(conversation => conversation.status === "closed")).toBe(true);
        expect(f.host.agent.state.messages.filter(isWake)).toEqual(admission.messages);
        expect(f.host.providerInputs).toHaveLength(requestCount ? 5 : 3);
        expect(f.host.pending()).toEqual([]);
        expect(f.inbox.status()).toEqual({ unread: 0, activeBatch: null, wakePending: false, admissionError: null });
        expect(f.admissionErrors).toEqual([]);
        expectDefaultModes(f.host);
        expectSuccessfulTools(f.host);
        expect(admission.messages[0]).toEqual(markerSnapshot);
      } finally { f.dispose(); }
    });
  }

  test("arrivals while a batch is active get one separate next wake, never join or overwrite that batch", async () => {
    const f = fixture();
    try {
      const first = [f.finalReply("Earlier final: revision 9"), f.request("Earlier exact request")];
      const later: AgentMessage[] = [];
      const consumer = installBatchConsumer(f, page => {
        if (later.length) return;
        expect(page.entries.map(entry => entry.message)).toEqual(first);
        later.push(f.finalReply("Later arrival: older revision 2"), f.request("Later independent exact request"));
        expect(f.host.admissions).toHaveLength(1);
        expect(f.inbox.read(page.batchId).entries.map(entry => entry.message)).toEqual(first);
      });
      await f.finishAdmission();
      await f.host.agent.continue();
      expect(consumer.completions).toEqual([{ batchId: consumer.pages[0].batchId, consumed: 2, remaining: 2 }]);
      expect(f.host.admissions).toHaveLength(2);
      expect(f.host.pending()).toEqual([]);
      expect(f.inbox.status()).toMatchObject({ unread: 2, activeBatch: null, wakePending: true });
      const oldBatch = consumer.pages[0].batchId;
      expect(() => f.inbox.complete(oldBatch)).toThrow();
      await f.finishAdmission(1);
      await f.host.agent.continue();
      expect(consumer.pages).toHaveLength(2);
      expect(consumer.pages[1].entries.map(entry => entry.message)).toEqual(later);
      expect(consumer.pages[1].entries.map(entry => entry.sequence)).toEqual([3, 4]);
      expect(consumer.pages[1].batchId).not.toBe(oldBatch);
      expect(consumer.completions[1]).toEqual({ batchId: consumer.pages[1].batchId, consumed: 2, remaining: 0 });
      expect(f.host.agent.state.messages.filter(isWake)).toHaveLength(2);
      expect(f.host.providerInputs).toHaveLength(8);
      expect(f.host.admissions).toHaveLength(2);
      expect(f.book.pending()).toEqual([]);
      expectSuccessfulTools(f.host);
      expectDefaultModes(f.host);
    } finally { f.dispose(); }
  });

  for (const when of ["before normalization", "after normalization"] as const) {
    test(`manual inbox read ${when} cancels only the exact wake`, async () => {
      const f = fixture();
      try {
        const steer = user("Unrelated steering remains visible");
        const followUp = user("Unrelated follow-up remains queued");
        f.host.agent.steer(steer);
        f.host.agent.followUp(followUp);
        const incoming = [f.finalReply("Keep the unread final"), f.request("Handle this exact request")];
        let admission: Admission | undefined;
        if (when === "after normalization") admission = await f.host.admit();
        const retainedBefore = structuredClone([steer, followUp]);
        const observed: QueuedMessage[][] = [];
        const detach = f.host.agent.onQueueChange(() => observed.push(f.host.pending().filter(message => message === steer || message === followUp)));
        const page = f.inbox.read();
        expect(page.entries.map(entry => entry.message)).toEqual(incoming);
        expect(f.host.pending()).toEqual([steer, followUp]);
        expect(() => f.inbox.complete(page.batchId)).toThrow();
        f.reply(incoming[1].messageId);
        expect(f.inbox.read(page.batchId).entries).toEqual(page.entries.map(entry => ({ ...entry, requiresReply: false })));
        expect(() => f.reply(incoming[1].messageId)).toThrow();
        expect(f.inbox.complete(page.batchId)).toEqual({ batchId: page.batchId, consumed: 2, remaining: 0 });
        admission ??= await f.host.admit();
        detach();
        expect(observed.every(items => items.length === 2 && items[0] === steer && items[1] === followUp)).toBe(true);
        admission.finish.resolve();
        await f.deliveries[0];
        expect(f.host.pending()).toEqual([steer, followUp]);
        expect([steer, followUp]).toEqual(retainedBefore);
        await f.host.agent.continue();
        expect(f.host.agent.state.messages.filter(isWake)).toEqual([]);
        expect(f.host.agent.state.messages.filter(message => message === steer || message === followUp)).toEqual([steer, followUp]);
        expect(f.host.providerInputs).toHaveLength(2);
        expectDefaultModes(f.host);
      } finally { f.dispose(); }
    });

    test(`request cancellation ${when} fences late admission without deleting user input`, async () => {
      const f = fixture();
      try {
        const earlier = user("Earlier user follow-up");
        f.host.agent.followUp(earlier);
        const message = f.request("Cancelled request");
        let admission: Admission | undefined;
        if (when === "after normalization") admission = await f.host.admit();
        const close = f.peer.stop(message.conversationId)!;
        expect(f.receive(close)).toBe("terminal");
        expect(f.inbox.status()).toMatchObject({ unread: 0, wakePending: false });
        admission ??= await f.host.admit();
        admission.finish.resolve();
        await f.deliveries[0];
        expect(f.host.pending()).toEqual([earlier]);
        await f.host.agent.continue();
        expect(f.host.agent.state.messages.filter(isWake)).toEqual([]);
        expect(f.host.agent.state.messages.filter(message => message === earlier)).toHaveLength(1);
        expect(f.host.admissions).toHaveLength(1);
        expect(f.host.providerInputs).toHaveLength(1);
        expectDefaultModes(f.host);
      } finally { f.dispose(); }
    });
  }

  test("native consumer reads every bounded page of escaped Unicode envelopes before completion", async () => {
    const f = fixture();
    try {
      const expected = Array.from({ length: 10 }, (_, index) => f.finalReply(`${index}: ${'"\\完成\n'.repeat(12000)}`));
      const consumer = installBatchConsumer(f);
      await f.finishAdmission();
      await f.host.agent.continue();
      expect(consumer.pages.length).toBeGreaterThan(1);
      expect(consumer.pages.every(page => Buffer.byteLength(JSON.stringify(page), "utf8") <= 1024 * 1024 && page.entries.length <= 32)).toBe(true);
      expect(consumer.pages.flatMap(page => page.entries.map(entry => entry.message))).toEqual(expected);
      expect(consumer.completions).toEqual([{ batchId: consumer.pages[0].batchId, consumed: 10, remaining: 0 }]);
      expect(f.host.agent.state.messages.filter(isWake)).toHaveLength(1);
      expect(f.host.admissions).toHaveLength(1);
      expectSuccessfulTools(f.host);
      expectDefaultModes(f.host);
    } finally { f.dispose(); }
  });

  test("an invalid or incomplete read cannot acknowledge a queued batch or consume its later arrivals", async () => {
    const f = fixture();
    try {
      const originals = Array.from({ length: 33 }, (_, index) => f.finalReply(`Exact final ${index}`));
      await f.finishAdmission();
      const firstPage = f.inbox.read();
      const retained = f.inbox.status();
      expect(firstPage.entries).toHaveLength(32);
      expect(() => f.inbox.complete(firstPage.batchId)).toThrow();
      expect(() => f.inbox.read(originals[0].messageId)).toThrow();
      expect(() => f.inbox.read(firstPage.batchId, -1)).toThrow();
      expect(() => f.inbox.read(firstPage.batchId, 34)).toThrow();
      expect(() => f.inbox.complete(originals[0].conversationId)).toThrow();
      expect(f.inbox.status()).toEqual(retained);
      const later = f.finalReply("Arrives after the immutable high watermark");
      const lastPage = f.inbox.read(firstPage.batchId, firstPage.nextOffset!);
      expect([...firstPage.entries, ...lastPage.entries].map(entry => entry.message)).toEqual(originals);
      expect(f.inbox.complete(firstPage.batchId)).toEqual({ batchId: firstPage.batchId, consumed: 33, remaining: 1 });
      expect(() => f.inbox.complete(firstPage.batchId)).toThrow();
      const consumer = installBatchConsumer(f);
      await f.finishAdmission(1);
      await f.host.agent.continue();
      expect(consumer.pages[0].entries.map(entry => entry.message)).toEqual([later]);
      expect(f.host.agent.state.messages.filter(isWake)).toHaveLength(1);
      expect(f.inbox.status().unread).toBe(0);
      expectSuccessfulTools(f.host);
    } finally { f.dispose(); }
  });

  test("manual completion after dequeue prevents an aborted wake from being replayed on native restoration", async () => {
    const f = fixture();
    const release = Promise.withResolvers<void>();
    try {
      f.finalReply("Final inspected before model commit");
      const admission = await f.finishAdmission();
      const marker = admission.messages[0];
      const snapshot = structuredClone(marker);
      Object.freeze(marker);
      const preparing = Promise.withResolvers<void>();
      const detach = f.host.agent.addBeforeModelCallHook(async () => {
        preparing.resolve();
        await release.promise;
      });
      const run = f.host.agent.continue();
      await preparing.promise;
      expect(f.host.pending()).toEqual([]);
      const page = f.inbox.read();
      f.inbox.complete(page.batchId);
      const abort = f.host.agent.abort();
      release.resolve();
      await Promise.all([run, abort]);
      detach();
      expect(f.host.agent.state.messages.includes(marker)).toBe(false);
      expect(f.host.providerInputs).toEqual([]);
      const userWork = user("Continue only the unrelated work after Esc");
      f.host.agent.followUp(userWork);
      await f.host.agent.continue();
      expect(f.host.agent.state.messages.filter(isWake)).toEqual([]);
      expect(f.host.agent.state.messages.filter(message => message === userWork)).toHaveLength(1);
      expect(f.host.pending()).toEqual([]);
      expect(marker).toEqual(snapshot);
      expectDefaultModes(f.host);
    } finally { release.resolve(); f.dispose(); }
  });

  test("failed wake admission preserves raw inbox recovery without retrying or clearing user queues", async () => {
    const f = fixture();
    try {
      const steering = user("User steering survives failed admission");
      const followUp = user("User follow-up survives failed admission");
      f.host.agent.steer(steering);
      f.host.agent.followUp(followUp);
      const original = f.finalReply("Final retained despite wake admission failure");
      const admission = await f.host.admit();
      const failure = new Error("Host normalization completion failed");
      const rejected = f.deliveries[0].catch(error => error);
      admission.finish.reject(failure);
      expect(await rejected).toBe(failure);
      expect(f.admissionErrors).toEqual([failure]);
      expect(f.inbox.status()).toMatchObject({ unread: 1, activeBatch: null, wakePending: false });
      expect(f.inbox.status().admissionError).toContain(failure.message);
      expect(f.host.pending()).toEqual([steering, followUp]);
      await f.host.agent.continue();
      expect(f.host.agent.state.messages.filter(isWake)).toEqual([]);
      expect(f.host.agent.state.messages.filter(message => message === steering || message === followUp)).toEqual([steering, followUp]);
      expect(f.host.admissions).toHaveLength(1);
      const page = f.inbox.read();
      expect(page.entries.map(entry => entry.message)).toEqual([original]);
      expect(f.inbox.complete(page.batchId)).toEqual({ batchId: page.batchId, consumed: 1, remaining: 0 });
      expect(f.host.admissions).toHaveLength(1);
      expectDefaultModes(f.host);
    } finally { f.dispose(); }
  });

  test("settling a stopped request preserves a closed conversation's unread final in the shared wake", async () => {
    const f = fixture();
    try {
      const request = f.request("Stop only this request");
      const final = f.finalReply("Final must still reach the receiver");
      const admission = await f.finishAdmission();
      f.book.stop(request.conversationId);
      f.inbox.settleRequests();
      expect(f.host.pending()).toEqual(admission.messages);
      const consumer = installBatchConsumer(f);
      await f.host.agent.continue();
      expect(consumer.pages.flatMap(page => page.entries.map(entry => entry.message))).toEqual([final]);
      expect(f.replies).toEqual([]);
      expect(consumer.completions).toEqual([{ batchId: consumer.pages[0].batchId, consumed: 1, remaining: 0 }]);
      expect(f.host.agent.state.messages.filter(isWake)).toHaveLength(1);
      expectSuccessfulTools(f.host);
    } finally { f.dispose(); }
  });

  test("reading a claimed idle wake aborts only that preparation, not queued user follow-up", async () => {
    const f = fixture();
    const release = Promise.withResolvers<void>();
    try {
      f.host.isStreaming = false;
      const message = f.finalReply("Manual final inspection while claimed");
      const admission = await f.finishAdmission();
      const marker = admission.messages[0];
      const unrelated = user("User work after claimed inbox wake");
      f.host.agent.followUp(unrelated);
      const claimed = Promise.withResolvers<AbortSignal>();
      let committed = false;
      f.host.agent.prepareQueuedMessages = async (messages, signal) => {
        if (!messages.includes(marker)) return undefined;
        claimed.resolve(signal);
        await release.promise;
        return { commit: () => { committed = true; return []; } };
      };
      const run = f.host.agent.continue();
      const signal = await claimed.promise;
      const page = f.inbox.read();
      expect(page.entries[0].message).toEqual(message);
      expect(signal.aborted).toBe(true);
      expect(f.host.pending()).toEqual([unrelated]);
      f.inbox.complete(page.batchId);
      release.resolve();
      await run;
      expect(committed).toBe(false);
      expect(f.host.agent.state.messages.includes(marker)).toBe(false);
      expect(f.host.agent.state.messages.filter(message => message === unrelated)).toHaveLength(1);
      expectDefaultModes(f.host);
    } finally { release.resolve(); f.dispose(); }
  });

  for (const originalQueue of ["steering", "followUp"] as const) {
    test(`manual batch consumption preserves dequeued user ${originalQueue} for native abort recovery`, async () => {
      const f = fixture();
      const release = Promise.withResolvers<void>();
      try {
        const original = user(`Uncommitted ${originalQueue} user input`);
        const snapshot = structuredClone(original);
        if (originalQueue === "steering") f.host.agent.steer(original);
        else f.host.agent.followUp(original);
        const request = f.request("Later batched request");
        const admission = await f.finishAdmission();
        const preparing = Promise.withResolvers<void>();
        const detach = f.host.agent.addBeforeModelCallHook(async () => {
          preparing.resolve();
          await release.promise;
        });
        const run = f.host.agent.continue();
        await preparing.promise;
        expect(f.host.pending()).toEqual(admission.messages);
        const page = f.inbox.read();
        f.reply(request.messageId);
        f.inbox.complete(page.batchId);
        const aborted = f.host.agent.abort();
        release.resolve();
        await Promise.all([run, aborted]);
        detach();
        expect(f.host.agent.state.messages.includes(original)).toBe(false);
        expect(f.host.agent.peekSteeringQueue()).toEqual(originalQueue === "steering" ? [original] : []);
        expect(f.host.agent.peekFollowUpQueue()).toEqual(originalQueue === "followUp" ? [original] : []);
        expect(original).toEqual(snapshot);
        expect(f.host.providerInputs).toEqual([]);
        await f.host.agent.continue();
        expect(f.host.agent.state.messages.filter(message => message === original)).toHaveLength(1);
        expect(f.host.agent.state.messages.filter(isWake)).toEqual([]);
        expect(f.host.pending()).toEqual([]);
        expectDefaultModes(f.host);
      } finally { release.resolve(); f.dispose(); }
    });
  }

  test("batch cancellation preserves existing host grouping instead of changing global dequeue behavior", async () => {
    const host = new BatchHost();
    const first = user("User group, part one");
    const second = user("User group, part two");
    const third = user("Separate user follow-up");
    host.agent.setQueuedMessageGrouping((previous, next) => previous === first && next === second);
    const f = fixture(host);
    try {
      host.agent.followUp(first);
      host.agent.followUp(second);
      f.finalReply("Manually inspected final");
      await f.finishAdmission();
      host.agent.followUp(third);
      const page = f.inbox.read();
      f.inbox.complete(page.batchId);
      expect(host.agent.peekFollowUpQueue()).toEqual([first, second, third]);
      await host.agent.continue();
      expect(host.providerInputs.map(messages => messages.filter(message => message.role === "user").map(message => message.content))).toEqual([
        ["User group, part one", "User group, part two"],
        ["User group, part one", "User group, part two", "Separate user follow-up"],
      ]);
      expect(host.agent.state.messages.filter(isWake)).toEqual([]);
      expectDefaultModes(host);
    } finally { f.dispose(); }
  });

  test("an incomplete active batch remains visible without automatic reminder turns or losing later arrivals", async () => {
    const f = fixture();
    try {
      const first = f.finalReply("Read but not completed");
      const consumer = installBatchConsumer(f);
      const originalResponder = f.host.respond;
      f.host.respond = context => context.messages.at(-1)?.role === "toolResult" ? STOP : originalResponder(context);
      await f.finishAdmission();
      await f.host.agent.continue();
      const page = consumer.pages[0];
      expect(page.entries[0].message).toEqual(first);
      expect(consumer.completions).toEqual([]);
      const later = f.finalReply("Retained for the next explicit batch");
      expect(f.host.admissions).toHaveLength(1);
      expect(f.host.pending()).toEqual([]);
      expect(f.inbox.status().activeBatch).toEqual({ batchId: page.batchId, highWatermark: 1, total: 1, read: 1 });
      f.host.agent.followUp(user("Unrelated user work must not replay the inbox wake"));
      await f.host.agent.continue();
      expect(f.host.providerInputs).toHaveLength(3);
      expect(f.host.agent.state.messages.filter(isWake)).toHaveLength(1);
      expect(f.inbox.read(page.batchId).entries.map(entry => entry.message)).toEqual([first]);
      expect(f.inbox.complete(page.batchId)).toEqual({ batchId: page.batchId, consumed: 1, remaining: 1 });
      expect(f.host.admissions).toHaveLength(2);
      f.host.respond = originalResponder;
      await f.finishAdmission(1);
      await f.host.agent.continue();
      expect(consumer.pages[1].entries.map(entry => entry.message)).toEqual([later]);
      expect(f.inbox.status().unread).toBe(0);
      expectSuccessfulTools(f.host);
    } finally { f.dispose(); }
  });
});
