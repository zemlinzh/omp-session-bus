import { createHash } from "node:crypto";
import {
  AGENT_ID_PATTERN,
  PROJECT_ID_PATTERN,
  DEFAULT_MAX_TURNS,
  PROTOCOL_VERSION,
  newConversationId,
  newMessageId,
  validateMessage,
  type AgentMessage,
} from "./protocol.js";

export const MAX_ACTIVE_CONVERSATIONS = 128;
export const MAX_PENDING_REQUESTS = 64;
export const MAX_CLOSED_CONVERSATIONS = 256;

type ConversationStatus = "awaiting-reply" | "needs-reply" | "closed";

interface Conversation {
  conversationId: string;
  peer: string;
  status: ConversationStatus;
  turn: number;
  maxTurns: number;
  lastMessageId: string;
  messageIds: string[];
  incomingCloseId?: string;
}

interface SeenMessage {
  conversationId: string;
  turn: number;
  fingerprint: string;
}

function fingerprint(message: AgentMessage): string {
  // Retain a digest rather than every potentially 128 KiB message body. Fixed
  // field order makes equality independent of the sender's object key order.
  return createHash("sha256").update(JSON.stringify([
    message.version,
    message.projectId,
    message.messageId,
    message.conversationId,
    message.from,
    message.to,
    message.inReplyTo,
    message.kind,
    message.text,
    message.turn,
    message.maxTurns,
    message.finished,
  ])).digest("hex");
}

export class ConversationBook {
  private readonly conversations = new Map<string, Conversation>();
  private readonly seen = new Map<string, SeenMessage>();
  private readonly pendingMessages = new Map<string, AgentMessage>();
  private readonly closedOrder = new Map<string, true>();
  private activeCount = 0;

  constructor(private readonly agentId: string, private readonly projectId: string) {
    if (!AGENT_ID_PATTERN.test(agentId)) throw new Error("Invalid local agent identity");
    if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("Invalid project identity");
  }

  start(to: string, text: string, maxTurns = DEFAULT_MAX_TURNS): AgentMessage {
    const message: AgentMessage = {
      version: PROTOCOL_VERSION,
      projectId: this.projectId,
      messageId: newMessageId(),
      conversationId: newConversationId(),
      from: this.agentId,
      to,
      inReplyTo: null,
      kind: "message",
      text,
      turn: 0,
      maxTurns,
      finished: false,
    };
    validateMessage(message);
    this.requireConversationCapacity();
    const conversation = this.addConversation(message, "awaiting-reply", to);
    this.record(conversation, message);
    return message;
  }

  receive(message: AgentMessage, beforeAccept?: () => void): "request" | "terminal" | "duplicate" {
    validateMessage(message);
    if (message.to !== this.agentId) throw new Error("Message is addressed to another agent");
    if (message.projectId !== this.projectId) throw new Error("Message belongs to another project");

    const seen = this.seen.get(message.messageId);
    if (seen) {
      if (seen.fingerprint !== fingerprint(message)) {
        throw new Error("Message ID was reused with a different envelope");
      }
      return "duplicate";
    }

    const conversation = this.conversations.get(message.conversationId);
    if (message.kind === "message") {
      if (conversation) throw new Error("Conversation already exists or is closed");
      this.requireConversationCapacity();
      this.requirePendingCapacity();
      beforeAccept?.();
      const incoming = this.addConversation(message, "needs-reply", message.from);
      this.record(incoming, message);
      this.pendingMessages.set(message.messageId, { ...message });
      return "request";
    }

    if (!conversation) throw new Error("Unknown conversation");
    if (conversation.peer !== message.from) throw new Error("Wrong conversation peer");
    if (conversation.maxTurns !== message.maxTurns) throw new Error("Conversation turn budget changed");

    if (message.kind === "close") {
      const reference = message.inReplyTo === null ? undefined : this.seen.get(message.inReplyTo);
      if (!reference || reference.conversationId !== conversation.conversationId || reference.turn !== message.turn) {
        throw new Error("Close message requires a known conversation message and its turn");
      }
      if (conversation.incomingCloseId !== undefined) throw new Error("Conversation already received a close");
      // A close can reference an earlier message: cancellation and an in-flight
      // reply may cross. It never advances the reply budget or creates work.
      this.record(conversation, message);
      conversation.incomingCloseId = message.messageId;
      this.closeConversation(conversation);
      return "terminal";
    }

    if (conversation.status === "closed") throw new Error("Conversation is closed");
    if (conversation.status !== "awaiting-reply") throw new Error("Conversation is not awaiting a reply");
    if (message.inReplyTo !== conversation.lastMessageId) throw new Error("Reply correlation does not match the last outgoing message");
    if (message.turn !== conversation.turn + 1) throw new Error("Reply turn is not consecutive");
    if (!message.finished) this.requirePendingCapacity();
    beforeAccept?.();

    this.record(conversation, message);
    conversation.lastMessageId = message.messageId;
    conversation.turn = message.turn;
    if (message.finished) {
      this.closeConversation(conversation);
      return "terminal";
    }
    conversation.status = "needs-reply";
    this.pendingMessages.set(message.messageId, { ...message });
    return "request";
  }

  reply(replyTo: string, text: string, done = false): AgentMessage {
    if (typeof done !== "boolean") throw new Error("Reply done flag must be boolean");
    const incoming = this.pendingMessages.get(replyTo);
    if (!incoming) throw new Error("Reply ID is not a pending incoming request");
    const conversation = this.conversations.get(incoming.conversationId);
    if (!conversation || conversation.status !== "needs-reply" || conversation.lastMessageId !== replyTo) {
      throw new Error("Conversation no longer needs this reply");
    }
    const turn = incoming.turn + 1;
    const message: AgentMessage = {
      version: PROTOCOL_VERSION,
      projectId: this.projectId,
      messageId: newMessageId(),
      conversationId: conversation.conversationId,
      from: this.agentId,
      to: conversation.peer,
      inReplyTo: replyTo,
      kind: "reply",
      text,
      turn,
      maxTurns: conversation.maxTurns,
      finished: done || turn === conversation.maxTurns,
    };
    validateMessage(message);
    this.record(conversation, message);
    this.pendingMessages.delete(replyTo);
    conversation.lastMessageId = message.messageId;
    conversation.turn = message.turn;
    if (message.finished) this.closeConversation(conversation);
    else conversation.status = "awaiting-reply";
    return message;
  }

  stop(conversationId: string, reason = "Conversation stopped"): AgentMessage | null {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.status === "closed") return null;
    const message: AgentMessage = {
      version: PROTOCOL_VERSION,
      projectId: this.projectId,
      messageId: newMessageId(),
      conversationId,
      from: this.agentId,
      to: conversation.peer,
      inReplyTo: conversation.lastMessageId,
      kind: "close",
      text: reason,
      turn: conversation.turn,
      maxTurns: conversation.maxTurns,
      finished: true,
    };
    validateMessage(message);
    this.record(conversation, message);
    this.closeConversation(conversation);
    return message;
  }

  fail(conversationId: string): void {
    const conversation = this.conversations.get(conversationId);
    if (conversation) this.closeConversation(conversation);
  }

  hasPendingMessage(messageId: string): boolean {
    return this.pendingMessages.has(messageId);
  }

  pending(): AgentMessage[] {
    // Callers may retain or alter display objects without changing correlation.
    return Array.from(this.pendingMessages.values(), message => ({ ...message }));
  }

  list(): Array<{
    conversationId: string;
    peer: string;
    status: ConversationStatus;
    turn: number;
    maxTurns: number;
  }> {
    return Array.from(this.conversations.values(), conversation => ({
      conversationId: conversation.conversationId,
      peer: conversation.peer,
      status: conversation.status,
      turn: conversation.turn,
      maxTurns: conversation.maxTurns,
    }));
  }

  closeAll(reason: string): AgentMessage[] {
    const messages: AgentMessage[] = [];
    // Closing can evict older tombstones, so do not iterate the mutating map.
    for (const conversationId of Array.from(this.conversations.keys())) {
      const message = this.stop(conversationId, reason);
      if (message) messages.push(message);
    }
    return messages;
  }

  private requireConversationCapacity(): void {
    if (this.activeCount >= MAX_ACTIVE_CONVERSATIONS) throw new Error("Active conversation capacity reached");
  }

  private requirePendingCapacity(): void {
    if (this.pendingMessages.size >= MAX_PENDING_REQUESTS) throw new Error("Pending request capacity reached");
  }

  private addConversation(message: AgentMessage, status: ConversationStatus, peer: string): Conversation {
    const conversation: Conversation = {
      conversationId: message.conversationId,
      peer,
      status,
      turn: message.turn,
      maxTurns: message.maxTurns,
      lastMessageId: message.messageId,
      messageIds: [],
    };
    this.conversations.set(conversation.conversationId, conversation);
    this.activeCount++;
    return conversation;
  }

  private record(conversation: Conversation, message: AgentMessage): void {
    this.seen.set(message.messageId, {
      conversationId: message.conversationId,
      turn: message.turn,
      fingerprint: fingerprint(message),
    });
    conversation.messageIds.push(message.messageId);
  }

  private closeConversation(conversation: Conversation): void {
    if (conversation.status === "closed") return;
    this.pendingMessages.delete(conversation.lastMessageId);
    conversation.status = "closed";
    this.activeCount--;
    this.closedOrder.set(conversation.conversationId, true);
    // Live threads are never evicted. Terminal bodies are not retained; the
    // newest 256 tombstones keep IDs/digests for recent replay rejection.
    while (this.closedOrder.size > MAX_CLOSED_CONVERSATIONS) {
      const oldest = this.closedOrder.keys().next().value;
      if (oldest === undefined) break;
      this.closedOrder.delete(oldest);
      const expired = this.conversations.get(oldest);
      if (expired) {
        for (const messageId of expired.messageIds) this.seen.delete(messageId);
        this.conversations.delete(oldest);
      }
    }
  }
}
