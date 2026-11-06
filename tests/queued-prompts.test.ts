import { describe, expect, test } from "bun:test";
import { Agent, type AgentMessage as QueuedMessage } from "@oh-my-pi/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from "@oh-my-pi/pi-ai";
import { ConversationBook } from "../src/conversations.js";
import { QueuedPeerPrompts, type QueuedPromptHost } from "../src/queued-prompts.js";
import type { AgentMessage } from "../src/protocol.js";

const A = "omp-0000000000000001";
const B = "omp-0000000000000002";
const C = "omp-0000000000000003";
const PROJECT = "project-11111111111111111111111111111111";
type CustomPrompt = Parameters<QueuedPromptHost["promptCustomMessage"]>[0];

interface Admission {
  enter: PromiseWithResolvers<void>;
  queued: PromiseWithResolvers<void>;
  finish: PromiseWithResolvers<void>;
  messages: QueuedMessage[];
}

/** Only admission/completion are controlled; storage, claims, restoration and dequeue use real agent-core. */
class QueueHost implements QueuedPromptHost {
  isStreaming = true;
  readonly admissions: Admission[] = [];
  prefix: QueuedMessage[] = [];
  readonly agent = new Agent({
    steeringMode: "all",
    followUpMode: "all",
    convertToLlm: messages => {
      const converted: Message[] = [];
      for (const message of messages) {
        if (message.role === "custom") {
          converted.push({ role: "user", content: typeof message.content === "string" ? message.content : "Custom notification", timestamp: message.timestamp });
        } else if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
          converted.push(message);
        }
      }
      return converted;
    },
    // No provider, credentials, echo or automatic formal reply. A fixed terminal
    // response lets the real loop drain queues and retain delivered identities.
    streamFn: model => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: "Queue processing completed." }], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: 0,
      };
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  });

  promptCustomMessage: QueuedPromptHost["promptCustomMessage"] = async (payload, options) => {
    const admission: Admission = {
      enter: Promise.withResolvers<void>(), queued: Promise.withResolvers<void>(), finish: Promise.withResolvers<void>(), messages: [],
    };
    this.admissions.push(admission);
    await admission.enter.promise;
    if (!options?.queueOnly || options.streamingBehavior !== "followUp") {
      throw new Error("This fixture admits queue-only custom follow-ups, not direct prompts");
    }
    // AgentSession normalizes asynchronously, then inserts the entire group and
    // reports its exact identities synchronously before scheduling idle drain.
    const custom: QueuedMessage = { ...payload, role: "custom", timestamp: 0 };
    admission.messages = [...this.prefix, custom];
    for (const message of admission.messages) this.agent.followUp(message);
    options.onPromptQueued?.(admission.messages);
    admission.queued.resolve();
    await admission.finish.promise;
    return true;
  };


  async admit(index = this.admissions.length - 1): Promise<Admission> {
    const admission = this.admissions[index];
    admission.enter.resolve();
    await admission.queued.promise;
    return admission;
  }

  pending(): readonly QueuedMessage[] {
    return [...this.agent.peekSteeringQueue(), ...this.agent.peekFollowUpQueue()];
  }
}

function payload(message: AgentMessage): CustomPrompt {
  return { customType: "session-bus-message", content: `Peer ${message.from}: ${message.text}`, display: true, attribution: "agent", details: message };
}

function user(text = "Unrelated foreground input"): QueuedMessage {
  return { role: "user", content: text, timestamp: 0 };
}

function fixture() {
  const sender = new ConversationBook(A, PROJECT);
  const book = new ConversationBook(B, PROJECT);
  const host = new QueueHost();
  const queue = new QueuedPeerPrompts(host, id => book.hasPendingMessage(id));
  const request = sender.start(B, "Handle this peer request", 40);
  book.receive(request);
  return { sender, book, host, queue, request };
}

function assertRetained(messages: readonly QueuedMessage[], snapshots: readonly QueuedMessage[]) {
  messages.forEach((message, index) => expect(message).toEqual(snapshots[index]));
}

describe("queued peer notifications and authoritative conversation state", () => {
  test("two threads manually list/reply for 20 rounds without replay while all notification completions remain pending", async () => {
    const { sender, book, host, queue, request } = fixture();
    const secondSender = new ConversationBook(C, PROJECT);
    const second = secondSender.start(B, "Independent thread", 40);
    book.receive(second);
    const threads = [{ sender, incoming: request }, { sender: secondSender, incoming: second }];
    const deliveries: Promise<void>[] = [];
    const retained: QueuedMessage[] = [];
    const snapshots: QueuedMessage[] = [];

    for (let round = 0; round < 20; round++) {
      for (const thread of threads) {
        deliveries.push(queue.submit(thread.incoming, payload(thread.incoming)));
        const admission = await host.admit();
        for (const message of admission.messages) {
          retained.push(message);
          snapshots.push(structuredClone(message));
          Object.freeze(message);
        }
      }
      expect(host.pending()).toHaveLength(2);
      const listed = book.pending();
      expect(listed.map(message => message.messageId).sort()).toEqual(threads.map(thread => thread.incoming.messageId).sort());
      expect(book.list().filter(thread => thread.status === "needs-reply")).toHaveLength(2);
      // Replies deliberately use reverse listing order, not queue order.
      for (const incoming of listed.reverse()) {
        const thread = threads.find(thread => thread.incoming.messageId === incoming.messageId)!;
        const response = book.reply(incoming.messageId, `Manual answer ${round + 1}`, round === 19);
        queue.cancelMessage(incoming.messageId);
        expect(thread.sender.receive(response)).toBe(round === 19 ? "terminal" : "request");
        if (round < 19) {
          thread.incoming = thread.sender.reply(response.messageId, `Next round ${round + 2}`);
          book.receive(thread.incoming);
        }
      }
      expect(host.pending()).toEqual([]);
      assertRetained(retained, snapshots);
    }

    expect(book.pending()).toEqual([]);
    expect(book.list().map(thread => thread.status)).toEqual(["closed", "closed"]);
    expect(sender.pending()).toEqual([]);
    expect(secondSender.pending()).toEqual([]);
    // Admission promises settle only after all 40 requests were formally handled.
    for (const admission of host.admissions) admission.finish.resolve();
    await Promise.all(deliveries);
    const unrelated = user();
    host.agent.followUp(unrelated);
    await host.agent.continue();
    expect(host.agent.state.messages.filter(message => retained.includes(message))).toEqual([]);
    expect(host.agent.state.messages.filter(message => message === unrelated)).toHaveLength(1);
    expect(host.pending()).toEqual([]);
    assertRetained(retained, snapshots);
    queue.dispose();
  });

  for (const terminal of ["done", "stop", "fail", "remote-close"] as const) {
    test(`${terminal} withdraws admitted actionable work but preserves unrelated work`, async () => {
      const { sender, book, host, queue, request } = fixture();
      const unrelatedSteer = user("Independent steering");
      const unrelatedFollowUp = user("Independent follow-up");
      host.agent.steer(unrelatedSteer);
      host.agent.followUp(unrelatedFollowUp);
      const delivery = queue.submit(request, payload(request));
      const admission = await host.admit();
      const snapshots = admission.messages.map(message => structuredClone(message));
      if (terminal === "done") {
        const reply = book.reply(request.messageId, "Finished", true);
        queue.cancelMessage(request.messageId);
        queue.cancelConversation(request.conversationId);
        expect(sender.receive(reply)).toBe("terminal");
      } else if (terminal === "stop") {
        book.stop(request.conversationId);
        queue.cancelConversation(request.conversationId);
      } else if (terminal === "fail") {
        book.fail(request.conversationId);
        queue.cancelConversation(request.conversationId);
      } else {
        expect(book.receive(sender.stop(request.conversationId)!)).toBe("terminal");
        queue.cancelConversation(request.conversationId);
      }
      expect(book.hasPendingMessage(request.messageId)).toBe(false);
      expect(book.pending()).toEqual([]);
      expect(host.pending()).toEqual([unrelatedSteer, unrelatedFollowUp]);
      admission.finish.resolve();
      await delivery;
      await host.agent.continue();
      expect(host.agent.state.messages.filter(message => admission.messages.includes(message))).toEqual([]);
      expect(host.agent.state.messages.filter(message => message === unrelatedSteer || message === unrelatedFollowUp)).toHaveLength(2);
      assertRetained(admission.messages, snapshots);
      queue.dispose();
    });
  }

  test("an answer during asynchronous normalization cannot leave a late actionable notification", async () => {
    const { book, host, queue, request } = fixture();
    const delivery = queue.submit(request, payload(request));
    book.reply(book.pending()[0].messageId, "Answered before admission", true);
    queue.cancelMessage(request.messageId);
    const admission = await host.admit();
    expect(host.pending()).toEqual([]);
    admission.finish.resolve();
    await delivery;
    expect(host.pending()).toEqual([]);
    queue.dispose();
  });

  test("authoritative liveness rejects late admission even without an explicit cancellation", async () => {
    const { book, host, queue, request } = fixture();
    const delivery = queue.submit(request, payload(request));
    book.fail(request.conversationId);
    const admission = await host.admit();
    expect(host.pending()).toEqual([]);
    admission.finish.resolve();
    await delivery;
    queue.dispose();
  });

  test("a retired exact object restored by the host is pruned at real dequeue", async () => {
    const { book, host, queue, request } = fixture();
    const delivery = queue.submit(request, payload(request));
    const admission = await host.admit();
    const retired = admission.messages[0];
    const snapshot = structuredClone(retired);
    Object.freeze(retired);
    book.reply(request.messageId, "Already answered", true);
    queue.cancelMessage(request.messageId);
    const unrelated = user();
    host.agent.replaceQueues([retired], [unrelated]);
    admission.finish.resolve();
    await delivery;
    await host.agent.continue();
    expect(host.pending()).toEqual([]);
    expect(host.agent.state.messages.includes(retired)).toBe(false);
    expect(host.agent.state.messages.filter(message => message === unrelated)).toHaveLength(1);
    expect(retired).toEqual(snapshot);
    queue.dispose();
  });

  test("a request answered without explicit cancellation is pruned before dequeue", async () => {
    const { book, host, queue, request } = fixture();
    const delivery = queue.submit(request, payload(request));
    const admission = await host.admit();
    book.reply(request.messageId, "Manual answer", true);
    const unrelated = user();
    host.agent.followUp(unrelated);
    admission.finish.resolve();
    await delivery;
    await host.agent.continue();
    expect(host.agent.state.messages.some(message => admission.messages.includes(message))).toBe(false);
    expect(host.agent.state.messages.includes(unrelated)).toBe(true);
    queue.dispose();
  });

  test("replacement fences the old late callback while the new book remains schedulable", async () => {
    const { book, host, queue, request } = fixture();
    const oldDelivery = queue.submit(request, payload(request));
    queue.dispose();
    const nextBook = new ConversationBook(B, PROJECT);
    const nextQueue = new QueuedPeerPrompts(host, id => nextBook.hasPendingMessage(id));
    const nextSender = new ConversationBook(C, PROJECT);
    const fresh = nextSender.start(B, "Fresh runtime request");
    nextBook.receive(fresh);
    const nextDelivery = nextQueue.submit(fresh, payload(fresh));
    const freshAdmission = await host.admit(1);
    const oldAdmission = await host.admit(0);
    expect(book.hasPendingMessage(request.messageId)).toBe(true);
    expect(host.pending()).toEqual(freshAdmission.messages);
    oldAdmission.finish.resolve();
    freshAdmission.finish.resolve();
    await Promise.all([oldDelivery, nextDelivery]);
    await host.agent.continue();
    expect(host.agent.state.messages.some(message => oldAdmission.messages.includes(message))).toBe(false);
    expect(host.agent.state.messages.filter(message => freshAdmission.messages.includes(message))).toEqual(freshAdmission.messages);
    expect(nextBook.hasPendingMessage(fresh.messageId)).toBe(true);
    nextQueue.dispose();
  });

  test("dispose withdraws admitted work and fences an additional late admission idempotently", async () => {
    const { sender, book, host, queue, request } = fixture();
    const firstDelivery = queue.submit(request, payload(request));
    await host.admit();
    const second = sender.start(B, "Not yet normalized");
    book.receive(second);
    const secondDelivery = queue.submit(second, payload(second));
    const unrelated = user();
    host.agent.followUp(unrelated);
    queue.dispose();
    queue.dispose();
    await host.admit();
    expect(host.pending()).toEqual([unrelated]);
    for (const admission of host.admissions) admission.finish.resolve();
    await Promise.all([firstDelivery, secondDelivery]);
    await host.agent.continue();
    expect(host.agent.state.messages.filter(message => message.role === "custom")).toEqual([]);
  });

  test("a genuine unhandled request is delivered exactly once with custom metadata and attribution intact", async () => {
    const { book, host, queue, request } = fixture();
    host.isStreaming = false;
    const custom = payload(request);
    const delivery = queue.submit(request, custom);
    const admission = await host.admit();
    const queued = admission.messages[0];
    expect(host.agent.peekSteeringQueue()).toEqual([queued]);
    expect(host.agent.peekFollowUpQueue()).toEqual([]);
    expect(queued).toMatchObject({ role: "custom", customType: "session-bus-message", display: true, attribution: "agent", details: request, content: custom.content });
    const snapshot = structuredClone(queued);
    admission.finish.resolve();
    await delivery;
    await host.agent.continue();
    expect(host.pending()).toEqual([]);
    expect(host.agent.state.messages.filter(message => message === queued)).toHaveLength(1);
    expect(book.hasPendingMessage(request.messageId)).toBe(true);
    // Run later unrelated work: retained history is not re-enqueued or rewritten.
    host.agent.followUp(user("Later unrelated work"));
    await host.agent.continue();
    book.reply(request.messageId, "Handled after delivery", true);
    queue.cancelMessage(request.messageId);
    queue.dispose();
    expect(host.agent.state.messages.filter(message => message === queued)).toHaveLength(1);
    expect(queued).toEqual(snapshot);
  });

  test("idle admission promotion never interrupts a foreground turn started during normalization", async () => {
    const { host, queue, request } = fixture();
    host.isStreaming = false;
    const delivery = queue.submit(request, payload(request));
    host.isStreaming = true;
    const foreground = user("Foreground batch started meanwhile");
    host.agent.steer(foreground);
    const admission = await host.admit();
    expect(host.agent.peekSteeringQueue()).toEqual([foreground]);
    expect(host.agent.peekFollowUpQueue()).toEqual(admission.messages);
    admission.finish.resolve();
    await delivery;
    queue.dispose();
  });

  test("originally busy follow-up stays non-interrupting even when admission finds the host idle", async () => {
    const { host, queue, request } = fixture();
    const delivery = queue.submit(request, payload(request));
    host.isStreaming = false;
    const admission = await host.admit();
    expect(host.agent.peekSteeringQueue()).toEqual([]);
    expect(host.agent.peekFollowUpQueue()).toEqual(admission.messages);
    admission.finish.resolve();
    await delivery;
    queue.dispose();
  });

  test("cancellation removes the whole admitted group by identity, not matching text or custom type", async () => {
    const { book, host, queue, request } = fixture();
    const notice: QueuedMessage = { role: "custom", customType: "normalization-notice", display: false, content: "Attachment normalized", timestamp: 0 };
    host.prefix = [notice];
    const delivery = queue.submit(request, payload(request));
    const admission = await host.admit();
    const lookalike: QueuedMessage = { ...admission.messages[1] };
    host.agent.followUp(lookalike);
    book.stop(request.conversationId);
    queue.cancelConversation(request.conversationId);
    expect(host.pending()).toEqual([lookalike]);
    expect(host.pending()[0]).toBe(lookalike);
    admission.finish.resolve();
    await delivery;
    await host.agent.continue();
    expect(host.agent.state.messages.filter(message => message === lookalike)).toHaveLength(1);
    expect(host.agent.state.messages.includes(notice)).toBe(false);
    queue.dispose();
  });

  test("admission failure retires owned objects without erasing unrelated queue entries", async () => {
    const { host, queue, request } = fixture();
    const delivery = queue.submit(request, payload(request));
    const rejected = delivery.catch(error => error);
    const admission = await host.admit();
    const unrelated = user();
    host.agent.followUp(unrelated);
    const failure = new Error("Admission completion failed");
    admission.finish.reject(failure);
    expect(await rejected).toBe(failure);
    expect(host.pending()).toEqual([unrelated]);
    host.agent.replaceQueues([], [...admission.messages, unrelated]);
    await host.agent.continue();
    expect(host.agent.state.messages.some(message => admission.messages.includes(message))).toBe(false);
    expect(host.agent.state.messages.includes(unrelated)).toBe(true);
    queue.dispose();
  });

  test("cancelAll removes pending ownership while leaving delivered identities untouched", async () => {
    const { sender, book, host, queue, request } = fixture();
    const delivery = queue.submit(request, payload(request));
    const firstAdmission = await host.admit();
    firstAdmission.finish.resolve();
    await delivery;
    await host.agent.continue();
    const delivered = firstAdmission.messages[0];
    const snapshot = structuredClone(delivered);
    Object.freeze(delivered);
    const second = sender.start(B, "Still queued");
    book.receive(second);
    const secondDelivery = queue.submit(second, payload(second));
    const secondAdmission = await host.admit();
    const unrelated = user();
    host.agent.followUp(unrelated);
    book.closeAll("Lifecycle reset");
    queue.cancelAll();
    expect(host.pending()).toEqual([unrelated]);
    expect(host.agent.state.messages.includes(delivered)).toBe(true);
    expect(delivered).toEqual(snapshot);
    secondAdmission.finish.resolve();
    await secondDelivery;
    queue.dispose();
  });
});

describe("queued peer notifications at real preparation boundaries", () => {
  test("answering a claimed notification cancels its pending commit and preserves the other queue", async () => {
    const { book, host, queue, request } = fixture();
    host.isStreaming = false;
    const delivery = queue.submit(request, payload(request));
    const admission = await host.admit();
    admission.finish.resolve();
    await delivery;
    const peerMessage = admission.messages[0];
    const unrelated = user();
    host.agent.followUp(unrelated);
    const claimed = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    let peerCommitted = false;
    host.agent.prepareQueuedMessages = async (messages, signal) => {
      if (!messages.includes(peerMessage)) return undefined;
      claimed.resolve(signal);
      await release.promise;
      return { commit: () => { peerCommitted = true; return []; } };
    };
    const drain = host.agent.continue();
    const signal = await claimed.promise;
    expect(host.agent.peekSteeringQueue()).toEqual([peerMessage]);
    book.reply(request.messageId, "Manual answer while claimed", true);
    queue.cancelMessage(request.messageId);
    expect(signal.aborted).toBe(true);
    expect(host.pending()).toEqual([unrelated]);
    release.resolve();
    await drain;
    expect(peerCommitted).toBe(false);
    expect(host.agent.state.messages.includes(peerMessage)).toBe(false);
    expect(host.agent.state.messages.filter(message => message === unrelated)).toHaveLength(1);
    queue.dispose();
  });

  test("retiring an already delivered identity does not abort unrelated in-flight preparation", async () => {
    const { book, host, queue, request } = fixture();
    const delivery = queue.submit(request, payload(request));
    const admission = await host.admit();
    admission.finish.resolve();
    await delivery;
    await host.agent.continue();
    const delivered = admission.messages[0];
    const snapshot = structuredClone(delivered);
    Object.freeze(delivered);
    const unrelated = user();
    host.agent.followUp(unrelated);
    const claimed = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    let committed = false;
    host.agent.prepareQueuedMessages = async (_messages, signal) => {
      claimed.resolve(signal);
      await release.promise;
      return { commit: () => { committed = true; return []; } };
    };
    const drain = host.agent.continue();
    const signal = await claimed.promise;
    book.reply(request.messageId, "Answer already-delivered request", true);
    queue.cancelMessage(request.messageId);
    queue.dispose();
    expect(signal.aborted).toBe(false);
    expect(host.pending()).toEqual([unrelated]);
    release.resolve();
    await drain;
    expect(committed).toBe(true);
    expect(host.agent.state.messages.filter(message => message === unrelated)).toHaveLength(1);
    expect(host.agent.state.messages.filter(message => message === delivered)).toHaveLength(1);
    expect(delivered).toEqual(snapshot);
  });

  test("cancelling a pending peer follow-up preserves dequeued user steering for abort restoration", async () => {
    const { book, host, queue, request } = fixture();
    const delivery = queue.submit(request, payload(request));
    const admission = await host.admit();
    admission.finish.resolve();
    await delivery;
    const unrelated = user("User input not yet committed to the model");
    host.agent.steer(unrelated);
    const preparing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    host.agent.addBeforeModelCallHook(async () => {
      preparing.resolve();
      await release.promise;
    });
    const run = host.agent.continue();
    await preparing.promise;
    expect(host.agent.peekSteeringQueue()).toEqual([]);
    expect(host.agent.peekFollowUpQueue()).toEqual(admission.messages);
    book.reply(request.messageId, "Close the peer request", true);
    queue.cancelMessage(request.messageId);
    const aborted = host.agent.abort();
    release.resolve();
    await Promise.all([run, aborted]);
    expect(host.agent.state.messages.includes(unrelated)).toBe(false);
    expect(host.agent.peekSteeringQueue()).toEqual([unrelated]);
    expect(host.agent.peekFollowUpQueue()).toEqual([]);
    queue.dispose();
  });

  test("cancelling a later peer follow-up preserves earlier dequeued follow-up input on abort", async () => {
    const { book, host, queue, request } = fixture();
    host.agent.setFollowUpMode("one-at-a-time");
    const unrelated = user("Earlier user follow-up not yet committed");
    host.agent.followUp(unrelated);
    const delivery = queue.submit(request, payload(request));
    const admission = await host.admit();
    admission.finish.resolve();
    await delivery;
    const preparing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    host.agent.addBeforeModelCallHook(async () => {
      preparing.resolve();
      await release.promise;
    });
    const run = host.agent.continue();
    await preparing.promise;
    expect(host.agent.peekFollowUpQueue()).toEqual(admission.messages);
    book.reply(request.messageId, "Close later peer work", true);
    queue.cancelMessage(request.messageId);
    const aborted = host.agent.abort();
    release.resolve();
    await Promise.all([run, aborted]);
    expect(host.agent.state.messages.includes(unrelated)).toBe(false);
    expect(host.agent.peekFollowUpQueue()).toEqual([unrelated]);
    expect(host.agent.peekSteeringQueue()).toEqual([]);
    queue.dispose();
  });

  test("peer cancellation never makes retained user steering disappear and reappear", async () => {
    const { book, host, queue, request } = fixture();
    host.isStreaming = false;
    const delivery = queue.submit(request, payload(request));
    const admission = await host.admit();
    admission.finish.resolve();
    await delivery;
    const first = user("Approval-watched user A");
    const last = user("Approval-watched user B");
    host.agent.replaceQueues([first, ...admission.messages, last], []);
    const observed: QueuedMessage[][] = [[first, last]];
    const detach = host.agent.onQueueChange(() => {
      observed.push(host.agent.peekSteeringQueue().filter(message => message.role === "user"));
    });
    book.reply(request.messageId, "Retire only the peer", true);
    queue.cancelMessage(request.messageId);
    detach();
    expect(host.agent.peekSteeringQueue()).toEqual([first, last]);
    expect(observed.every(messages => messages.length === 2 && messages[0] === first && messages[1] === last)).toBe(true);
    queue.dispose();
  });
});
