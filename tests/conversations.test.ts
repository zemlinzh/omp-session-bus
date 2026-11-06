import { describe, expect, test } from "bun:test";
import {
  ConversationBook,
  MAX_ACTIVE_CONVERSATIONS,
  MAX_CLOSED_CONVERSATIONS,
  MAX_PENDING_REQUESTS,
} from "../src/conversations.js";
import {
  DEFAULT_MAX_TURNS,
  MAX_TEXT_BYTES,
  MAX_TURNS,
  PROTOCOL_VERSION,
  newConversationId,
  newMessageId,
  type AgentMessage,
  type MessageReceipt,
} from "../src/protocol.js";

const A = "omp-0000000000000001";
const B = "omp-0000000000000002";
const C = "omp-0000000000000003";
const PROJECT_A = "project-11111111111111111111111111111111";
const PROJECT_B = "project-22222222222222222222222222222222";

function initial(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    version: PROTOCOL_VERSION,
    projectId: PROJECT_A,
    messageId: newMessageId(),
    conversationId: newConversationId(),
    from: A,
    to: B,
    inReplyTo: null,
    kind: "message",
    text: "Please discuss this request",
    turn: 0,
    maxTurns: 4,
    finished: false,
    ...overrides,
  };
}

function formalReply(message: AgentMessage, overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    version: PROTOCOL_VERSION,
    projectId: message.projectId,
    messageId: newMessageId(),
    conversationId: message.conversationId,
    from: message.to,
    to: message.from,
    inReplyTo: message.messageId,
    kind: "reply",
    text: "Here is a formal response",
    turn: message.turn + 1,
    maxTurns: message.maxTurns,
    finished: message.turn + 1 === message.maxTurns,
    ...overrides,
  };
}

function closeFor(message: AgentMessage, overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    ...formalReply(message),
    kind: "close",
    text: "Conversation stopped",
    turn: message.turn,
    finished: true,
    ...overrides,
  };
}

function state(book: ConversationBook, conversationId: string) {
  return book.list().find(conversation => conversation.conversationId === conversationId);
}

describe("ConversationBook alternating formal replies", () => {
  test("completes two-party dialogue exactly at its shared finite turn limit", () => {
    const a = new ConversationBook(A, PROJECT_A);
    const b = new ConversationBook(B, PROJECT_A);
    let message = a.start(B, "Discuss the problem", 4);
    const conversationId = message.conversationId;
    expect(a.pending()).toEqual([]);
    expect(state(a, conversationId)?.status).toBe("awaiting-reply");
    expect(b.receive(message)).toBe("request");

    let sender = b;
    let receiver = a;
    for (let turn = 1; turn <= 4; turn++) {
      expect(sender.pending().map(pending => pending.messageId)).toEqual([message.messageId]);
      const next = sender.reply(message.messageId, `Response ${turn}`, false);
      expect(next.conversationId).toBe(conversationId);
      expect(next.inReplyTo).toBe(message.messageId);
      expect(next.from).toBe(message.to);
      expect(next.to).toBe(message.from);
      expect(next.turn).toBe(turn);
      expect(next.maxTurns).toBe(4);
      expect(next.finished).toBe(turn === 4);
      expect(sender.pending()).toEqual([]);
      expect(receiver.receive(next)).toBe(turn === 4 ? "terminal" : "request");
      message = next;
      [sender, receiver] = [receiver, sender];
    }

    expect(a.pending()).toEqual([]);
    expect(b.pending()).toEqual([]);
    expect(state(a, conversationId)).toEqual({ conversationId, peer: B, status: "closed", turn: 4, maxTurns: 4 });
    expect(state(b, conversationId)).toEqual({ conversationId, peer: A, status: "closed", turn: 4, maxTurns: 4 });
    expect(() => sender.reply(message.messageId, "Continue")).toThrow();
    expect(() => sender.receive(formalReply(message, { turn: 4 }))).toThrow();
  });

  test("an explicit done response closes the peer conversation without leaving a reply pending", () => {
    const a = new ConversationBook(A, PROJECT_A);
    const b = new ConversationBook(B, PROJECT_A);
    const request = a.start(B, "A short question", 8);
    expect(b.receive(request)).toBe("request");
    const terminal = b.reply(request.messageId, "No further discussion is needed", true);
    expect(terminal.turn).toBe(1);
    expect(terminal.finished).toBe(true);
    expect(a.receive(terminal)).toBe("terminal");
    expect(a.pending()).toEqual([]);
    expect(b.pending()).toEqual([]);
    expect(state(a, request.conversationId)?.status).toBe("closed");
    expect(state(b, request.conversationId)?.status).toBe("closed");
    expect(() => a.reply(terminal.messageId, "Extra reply")).toThrow();
    expect(() => b.reply(request.messageId, "Second reply")).toThrow();
  });

  test("default, minimum, and maximum reply budgets are enforced", () => {
    const a = new ConversationBook(A, PROJECT_A);
    expect(a.start(B, "Use default budget").maxTurns).toBe(DEFAULT_MAX_TURNS);
    expect(a.start(B, "Use maximum budget", MAX_TURNS).maxTurns).toBe(MAX_TURNS);
    for (const maxTurns of [0, -1, 1.5, MAX_TURNS + 1, Number.NaN]) {
      expect(() => a.start(B, "Invalid budget", maxTurns)).toThrow();
    }
    const b = new ConversationBook(B, PROJECT_A);
    const request = a.start(B, "Only one reply", 1);
    b.receive(request);
    const reply = b.reply(request.messageId, "Final at first reply");
    expect(reply.finished).toBe(true);
    expect(a.receive(reply)).toBe("terminal");
  });

  test("receipts are not messages and cannot create pending model work", () => {
    const a = new ConversationBook(A, PROJECT_A);
    const request = a.start(B, "A request");
    const receipt: MessageReceipt = {
      projectId: PROJECT_A,
      messageId: request.messageId,
      from: B,
      to: A,
      accepted: true,
      duplicate: false,
      receivedAt: new Date().toISOString(),
    };
    expect(() => a.receive(receipt as unknown as AgentMessage)).toThrow();
    expect(a.pending()).toEqual([]);
    expect(state(a, request.conversationId)?.status).toBe("awaiting-reply");
  });
});

describe("ConversationBook concurrent correlation", () => {
  test("accepts different thread reply order and replies to exactly the selected pending ID", () => {
    const a = new ConversationBook(A, PROJECT_A);
    const b = new ConversationBook(B, PROJECT_A);
    const first = a.start(B, "First thread", 4);
    const second = a.start(B, "Second thread", 6);
    b.receive(first);
    b.receive(second);
    expect(b.pending().map(message => message.messageId)).toEqual([first.messageId, second.messageId]);

    const secondReply = b.reply(second.messageId, "Answer second first");
    expect(b.pending().map(message => message.messageId)).toEqual([first.messageId]);
    expect(a.receive(secondReply)).toBe("request");
    const firstReply = b.reply(first.messageId, "Answer first second");
    expect(a.receive(firstReply)).toBe("request");
    expect(a.pending().map(message => message.messageId)).toEqual([secondReply.messageId, firstReply.messageId]);

    const firstFollowUp = a.reply(firstReply.messageId, "Follow first explicitly");
    expect(firstFollowUp.conversationId).toBe(first.conversationId);
    expect(firstFollowUp.inReplyTo).toBe(firstReply.messageId);
    expect(firstFollowUp.maxTurns).toBe(4);
    expect(a.pending().map(message => message.messageId)).toEqual([secondReply.messageId]);
    const secondFollowUp = a.reply(secondReply.messageId, "Follow second explicitly");
    expect(secondFollowUp.conversationId).toBe(second.conversationId);
    expect(secondFollowUp.inReplyTo).toBe(secondReply.messageId);
    expect(secondFollowUp.maxTurns).toBe(6);
    expect(b.receive(secondFollowUp)).toBe("request");
    expect(b.receive(firstFollowUp)).toBe("request");
  });

  test("rejects wrong identity, correlation, turn, and immutable budget without consuming the expected reply", () => {
    const a = new ConversationBook(A, PROJECT_A);
    const first = a.start(B, "First", 4);
    const second = a.start(C, "Second", 6);
    const invalid = [
      formalReply(first, { from: C }),
      formalReply(first, { to: C }),
      formalReply(first, { projectId: PROJECT_B }),
      formalReply(first, { inReplyTo: second.messageId }),
      formalReply(first, { inReplyTo: newMessageId() }),
      formalReply(first, { turn: 2 }),
      formalReply(first, { maxTurns: 5 }),
      formalReply(first, { conversationId: newConversationId() }),
      formalReply(first, { turn: 4, finished: false }),
    ];
    for (const message of invalid) expect(() => a.receive(message)).toThrow();
    expect(a.pending()).toEqual([]);
    expect(state(a, first.conversationId)?.status).toBe("awaiting-reply");
    expect(state(a, first.conversationId)?.turn).toBe(0);
    expect(a.receive(formalReply(first))).toBe("request");
    expect(state(a, second.conversationId)?.status).toBe("awaiting-reply");
  });

  test("another project's request cannot create work or consume a reply in this project", () => {
    const receiver = new ConversationBook(B, PROJECT_B);
    const otherProjectRequest = initial();
    expect(() => receiver.receive(otherProjectRequest)).toThrow();
    expect(receiver.pending()).toEqual([]);
    expect(receiver.list()).toEqual([]);
    const sender = new ConversationBook(C, PROJECT_B);
    const sameProjectRequest = sender.start(B, "A correctly scoped request");
    expect(receiver.receive(sameProjectRequest)).toBe("request");
    const reply = receiver.reply(sameProjectRequest.messageId, "Scoped response", true);
    expect(reply.projectId).toBe(PROJECT_B);
    expect(sender.receive(reply)).toBe("terminal");
  });

  test("missing project identity and unscoped legacy messages are rejected", () => {
    expect(() => new ConversationBook(A, "")).toThrow();
    const receiver = new ConversationBook(B, PROJECT_A);
    expect(() => receiver.receive({ ...initial(), projectId: undefined } as unknown as AgentMessage)).toThrow();
    expect(() => receiver.receive({ ...initial(), version: 1 } as unknown as AgentMessage)).toThrow();
    expect(receiver.pending()).toEqual([]);
  });

  test("requires initial turn zero and forbids uncorrelated replies or a second initial message", () => {
    const b = new ConversationBook(B, PROJECT_A);
    const request = initial();
    for (const message of [
      { ...request, turn: 1 },
      { ...request, inReplyTo: newMessageId() },
      { ...request, finished: true },
      { ...request, kind: "reply" as const, inReplyTo: newMessageId(), turn: 1 },
      { ...request, kind: "close" as const, finished: true },
    ]) expect(() => b.receive(message)).toThrow();
    expect(b.pending()).toEqual([]);
    expect(b.receive(request)).toBe("request");
    expect(() => b.receive({ ...request, messageId: newMessageId() })).toThrow();
    expect(() => b.receive(formalReply(request, { from: A, to: B }))).toThrow();
    expect(b.pending().map(message => message.messageId)).toEqual([request.messageId]);
  });

  test("outgoing, unknown, and already consumed IDs cannot consume another request", () => {
    const a = new ConversationBook(A, PROJECT_A);
    const b = new ConversationBook(B, PROJECT_A);
    const first = a.start(B, "First");
    const second = a.start(B, "Second");
    b.receive(first);
    b.receive(second);
    expect(() => b.reply(newMessageId(), "Unknown")).toThrow();
    const reply = b.reply(first.messageId, "First response");
    expect(() => b.reply(first.messageId, "Already consumed")).toThrow();
    expect(() => b.reply(reply.messageId, "Outgoing ID")).toThrow();
    expect(b.pending().map(message => message.messageId)).toEqual([second.messageId]);
  });

  test("invalid response text leaves the explicit pending request available", () => {
    const b = new ConversationBook(B, PROJECT_A);
    const request = initial();
    b.receive(request);
    expect(() => b.reply(request.messageId, "   ")).toThrow();
    expect(() => b.reply(request.messageId, "x".repeat(MAX_TEXT_BYTES + 1))).toThrow();
    expect(b.pending().map(message => message.messageId)).toEqual([request.messageId]);
    expect(b.reply(request.messageId, "Valid response").inReplyTo).toBe(request.messageId);
  });
});

describe("ConversationBook duplicate and mutation handling", () => {
  test("exact request and reply duplicates are idempotent even after the thread closes", () => {
    const a = new ConversationBook(A, PROJECT_A);
    const b = new ConversationBook(B, PROJECT_A);
    const request = a.start(B, "Question");
    expect(b.receive(request)).toBe("request");
    expect(b.receive({ ...request })).toBe("duplicate");
    expect(b.pending()).toHaveLength(1);
    const reply = b.reply(request.messageId, "Response");
    expect(b.receive({ ...request })).toBe("duplicate");
    expect(b.pending()).toEqual([]);
    expect(a.receive(reply)).toBe("request");
    expect(a.receive({ ...reply })).toBe("duplicate");
    expect(a.pending()).toHaveLength(1);
    const terminal = a.reply(reply.messageId, "Done", true);
    expect(b.receive(terminal)).toBe("terminal");
    expect(b.receive({ ...terminal })).toBe("duplicate");
    expect(b.receive({ ...request })).toBe("duplicate");
    expect(a.receive({ ...reply })).toBe("duplicate");
    expect(a.pending()).toEqual([]);
    expect(b.pending()).toEqual([]);
  });

  test("the same ID with changed envelope fields rejects rather than being silently deduplicated", () => {
    const b = new ConversationBook(B, PROJECT_A);
    const request = initial();
    b.receive(request);
    for (const patch of [
      { text: "Tampered text" },
      { from: C },
      { conversationId: newConversationId() },
      { maxTurns: 5 },
      { kind: "close" as const, inReplyTo: request.messageId, finished: true },
    ]) expect(() => b.receive({ ...request, ...patch })).toThrow();
    expect(b.pending().map(message => message.messageId)).toEqual([request.messageId]);
    const reply = b.reply(request.messageId, "Valid response");
    const a = new ConversationBook(A, PROJECT_A);
    const outgoing = a.start(B, "Other request");
    const accepted = formalReply(outgoing);
    a.receive(accepted);
    expect(() => a.receive({ ...accepted, text: reply.text })).toThrow();
    expect(a.pending()).toHaveLength(1);
  });

  test("envelope field order does not affect exact duplicate recognition", () => {
    const b = new ConversationBook(B, PROJECT_A);
    const request = initial();
    b.receive(request);
    const reordered = Object.fromEntries(Object.entries(request).reverse()) as unknown as AgentMessage;
    expect(b.receive(reordered)).toBe("duplicate");
    expect(b.pending()).toHaveLength(1);
  });

  test("caller mutation of inputs or returned pending/list snapshots cannot change recorded state", () => {
    const b = new ConversationBook(B, PROJECT_A);
    const request = initial();
    const original = { ...request };
    b.receive(request);
    request.text = "Changed caller input";
    request.maxTurns = 6;
    const pending = b.pending();
    pending[0]!.messageId = newMessageId();
    pending[0]!.maxTurns = 8;
    const listed = b.list();
    listed[0]!.peer = C;
    listed[0]!.status = "closed";
    expect(b.receive(original)).toBe("duplicate");
    expect(() => b.receive(request)).toThrow();
    const reply = b.reply(original.messageId, "Reply using saved correlation");
    expect(reply.inReplyTo).toBe(original.messageId);
    expect(reply.to).toBe(A);
    expect(reply.maxTurns).toBe(4);
  });
});

describe("ConversationBook termination", () => {
  test("stop closes locally before delivery, emits a no-budget close, and is idempotent", () => {
    const a = new ConversationBook(A, PROJECT_A);
    const b = new ConversationBook(B, PROJECT_A);
    const request = a.start(B, "Question", 4);
    b.receive(request);
    const close = b.stop(request.conversationId, "User cancellation")!;
    expect(close.kind).toBe("close");
    expect(close.text).toBe("User cancellation");
    expect(close.inReplyTo).toBe(request.messageId);
    expect(close.turn).toBe(0);
    expect(close.maxTurns).toBe(4);
    expect(close.finished).toBe(true);
    expect(state(b, request.conversationId)?.status).toBe("closed");
    expect(b.pending()).toEqual([]);
    expect(b.stop(request.conversationId)).toBeNull();
    expect(a.receive(close)).toBe("terminal");
    expect(a.receive({ ...close })).toBe("duplicate");
    expect(state(a, request.conversationId)?.status).toBe("closed");
    expect(a.pending()).toEqual([]);
    expect(() => b.reply(request.messageId, "Cannot continue")).toThrow();
  });

  test("a cancellation crossing an in-flight reply closes both sides without waking either", () => {
    const a = new ConversationBook(A, PROJECT_A);
    const b = new ConversationBook(B, PROJECT_A);
    const request = a.start(B, "Question");
    b.receive(request);
    const inFlight = b.reply(request.messageId, "Already on the wire");
    const close = a.stop(request.conversationId)!;
    expect(close.inReplyTo).toBe(request.messageId);
    expect(close.turn).toBe(0);
    expect(b.receive(close)).toBe("terminal");
    expect(state(b, request.conversationId)?.turn).toBe(1);
    expect(() => a.receive(inFlight)).toThrow();
    expect(a.pending()).toEqual([]);
    expect(b.pending()).toEqual([]);
    expect(state(a, request.conversationId)?.status).toBe("closed");
    expect(state(b, request.conversationId)?.status).toBe("closed");
  });

  test("simultaneous explicit stops remain terminal and accept each other's correlated close", () => {
    const a = new ConversationBook(A, PROJECT_A);
    const b = new ConversationBook(B, PROJECT_A);
    const request = a.start(B, "Question");
    b.receive(request);
    const aClose = a.stop(request.conversationId)!;
    const bClose = b.stop(request.conversationId)!;
    expect(a.receive(bClose)).toBe("terminal");
    expect(b.receive(aClose)).toBe("terminal");
    expect(a.receive(bClose)).toBe("duplicate");
    expect(b.receive(aClose)).toBe("duplicate");
    expect(a.pending()).toEqual([]);
    expect(b.pending()).toEqual([]);
    expect(() => a.receive({ ...bClose, messageId: newMessageId() })).toThrow();
  });

  test("invalid close identity, budget, correlation, or referenced turn cannot stop live work", () => {
    const b = new ConversationBook(B, PROJECT_A);
    const request = initial();
    const other = initial();
    b.receive(request);
    b.receive(other);
    for (const message of [
      closeFor(request, { from: C, to: B }),
      closeFor(request, { from: A, to: B, maxTurns: 5 }),
      closeFor(request, { from: A, to: B, inReplyTo: null }),
      closeFor(request, { from: A, to: B, inReplyTo: newMessageId() }),
      closeFor(request, { from: A, to: B, inReplyTo: other.messageId }),
      closeFor(request, { from: A, to: B, turn: 1 }),
      closeFor(request, { from: A, to: B, finished: false }),
    ]) expect(() => b.receive(message)).toThrow();
    expect(b.pending()).toHaveLength(2);
    expect(state(b, request.conversationId)?.status).toBe("needs-reply");
    expect(b.receive(closeFor(request, { from: A, to: B }))).toBe("terminal");
    expect(b.pending().map(message => message.messageId)).toEqual([other.messageId]);
  });

  test("delivery failure closes outgoing waits and incoming work without retry or revival", () => {
    const a = new ConversationBook(A, PROJECT_A);
    const b = new ConversationBook(B, PROJECT_A);
    const request = a.start(B, "Question");
    b.receive(request);
    a.fail(request.conversationId);
    b.fail(request.conversationId);
    a.fail(request.conversationId);
    a.fail(newConversationId());
    expect(a.pending()).toEqual([]);
    expect(b.pending()).toEqual([]);
    expect(a.stop(request.conversationId)).toBeNull();
    expect(b.stop(request.conversationId)).toBeNull();
    expect(() => a.receive(formalReply(request))).toThrow();
    expect(() => b.reply(request.messageId, "Cannot continue")).toThrow();
    expect(b.receive({ ...request })).toBe("duplicate");
    expect(() => b.receive({ ...request, messageId: newMessageId() })).toThrow();
    expect(state(a, request.conversationId)?.status).toBe("closed");
    expect(state(b, request.conversationId)?.status).toBe("closed");
  });

  test("closeAll closes every open thread and does not re-emit terminal conversations", () => {
    const a = new ConversationBook(A, PROJECT_A);
    const b = new ConversationBook(B, PROJECT_A);
    const first = a.start(B, "First");
    const second = a.start(B, "Second");
    const incoming = b.start(A, "Incoming");
    b.receive(first);
    b.receive(second);
    a.receive(incoming);
    const stopped = a.start(B, "Already stopped");
    a.fail(stopped.conversationId);
    const closes = a.closeAll("Session ending");
    expect(closes.map(message => message.conversationId).sort()).toEqual([
      first.conversationId, second.conversationId, incoming.conversationId,
    ].sort());
    expect(closes.every(message => message.kind === "close" && message.text === "Session ending")).toBe(true);
    expect(a.pending()).toEqual([]);
    expect(a.list().every(conversation => conversation.status === "closed")).toBe(true);
    for (const close of closes) expect(b.receive(close)).toBe("terminal");
    expect(b.pending()).toEqual([]);
    expect(a.closeAll("Again")).toEqual([]);
  });
});

describe("ConversationBook bounded retained work", () => {
  test("rejects active conversation overflow without evicting or altering live waits", () => {
    const a = new ConversationBook(A, PROJECT_A);
    const requests: AgentMessage[] = [];
    for (let index = 0; index < MAX_ACTIVE_CONVERSATIONS; index++) requests.push(a.start(B, `Request ${index}`));
    expect(() => a.start(B, "Overflow")).toThrow(/capacity/);
    expect(a.list()).toHaveLength(MAX_ACTIVE_CONVERSATIONS);
    expect(a.list().every(conversation => conversation.status === "awaiting-reply")).toBe(true);
    expect(a.receive(formalReply(requests[0]!, { finished: true }))).toBe("terminal");
    expect(a.start(B, "Slot freed").kind).toBe("message");
    expect(state(a, requests[1]!.conversationId)?.status).toBe("awaiting-reply");
  });

  test("pending overflow rejects new requests but a capacity rejection is safe to retry after a slot frees", () => {
    const b = new ConversationBook(B, PROJECT_A);
    const requests: AgentMessage[] = [];
    for (let index = 0; index < MAX_PENDING_REQUESTS; index++) {
      const request = initial();
      requests.push(request);
      expect(b.receive(request)).toBe("request");
    }
    const overflow = initial();
    expect(() => b.receive(overflow)).toThrow(/capacity/);
    expect(b.pending()).toHaveLength(MAX_PENDING_REQUESTS);
    expect(state(b, overflow.conversationId)).toBeUndefined();
    b.reply(requests[0]!.messageId, "Finish one", true);
    expect(b.receive(overflow)).toBe("request");
    expect(b.pending()).toHaveLength(MAX_PENDING_REQUESTS);
    expect(state(b, requests[1]!.conversationId)?.status).toBe("needs-reply");
  });

  test("a formal reply hitting pending capacity is not recorded and can be delivered after capacity frees", () => {
    const b = new ConversationBook(B, PROJECT_A);
    const outgoing = b.start(A, "Awaiting a reply");
    const requests: AgentMessage[] = [];
    for (let index = 0; index < MAX_PENDING_REQUESTS; index++) {
      const request = initial();
      requests.push(request);
      b.receive(request);
    }
    const reply = formalReply(outgoing);
    expect(() => b.receive(reply)).toThrow(/capacity/);
    expect(state(b, outgoing.conversationId)?.status).toBe("awaiting-reply");
    expect(state(b, outgoing.conversationId)?.turn).toBe(0);
    b.reply(requests[0]!.messageId, "Free capacity", true);
    expect(b.receive(reply)).toBe("request");
    expect(b.pending().some(message => message.messageId === reply.messageId)).toBe(true);
  });

  test("bounded tombstones retain recent replay protection and never evict a live conversation", () => {
    const b = new ConversationBook(B, PROJECT_A);
    const live = initial();
    b.receive(live);
    const completed: AgentMessage[] = [];
    for (let index = 0; index < MAX_CLOSED_CONVERSATIONS + 8; index++) {
      const request = initial();
      completed.push(request);
      b.receive(request);
      b.reply(request.messageId, "Done", true);
    }
    expect(b.list()).toHaveLength(MAX_CLOSED_CONVERSATIONS + 1);
    expect(state(b, completed[0]!.conversationId)).toBeUndefined();
    const recent = completed[completed.length - 1]!;
    expect(b.receive({ ...recent })).toBe("duplicate");
    expect(() => b.receive({ ...recent, messageId: newMessageId() })).toThrow();
    expect(() => b.receive({ ...recent, text: "Tampered replay" })).toThrow();
    expect(b.pending().map(message => message.messageId)).toEqual([live.messageId]);
    expect(state(b, live.conversationId)?.status).toBe("needs-reply");
    expect(b.reply(live.messageId, "Live work survived").inReplyTo).toBe(live.messageId);
  });

  test("closeAll remains complete when closing active threads evicts older terminal tombstones", () => {
    const a = new ConversationBook(A, PROJECT_A);
    for (let index = 0; index < MAX_CLOSED_CONVERSATIONS; index++) {
      const request = a.start(B, "Terminal history");
      a.fail(request.conversationId);
    }
    const live: AgentMessage[] = [];
    for (let index = 0; index < MAX_ACTIVE_CONVERSATIONS; index++) live.push(a.start(B, "Live request"));
    const closes = a.closeAll("Shutdown");
    expect(closes).toHaveLength(MAX_ACTIVE_CONVERSATIONS);
    expect(new Set(closes.map(message => message.conversationId))).toEqual(new Set(live.map(message => message.conversationId)));
    expect(a.pending()).toEqual([]);
    expect(a.list()).toHaveLength(MAX_CLOSED_CONVERSATIONS);
    expect(a.list().every(conversation => conversation.status === "closed")).toBe(true);
  });
});
