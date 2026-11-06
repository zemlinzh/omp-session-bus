import { randomBytes } from "node:crypto";

export const PROTOCOL_VERSION = 2;
export const DEFAULT_MAX_TURNS = 8;
export const MAX_TURNS = 64;
export const MAX_TEXT_BYTES = 128 * 1024;
export const MAX_FRAME_BYTES = 256 * 1024;
export const AGENT_ID_PATTERN = /^omp-[a-f0-9]{16}$/;
export const PROJECT_ID_PATTERN = /^project-[a-f0-9]{32}$/;
export const CONVERSATION_ID_PATTERN = /^chat-[a-f0-9]{32}$/;
export const MESSAGE_ID_PATTERN = /^msg-[a-f0-9]{32}$/;

export type AgentState = "idle" | "busy";

export interface PeerInfo {
  agentId: string;
  projectId: string;
  projectName: string;
  pid: number;
  cwd: string;
  sessionId: string;
  state: AgentState;
  startedAt: string;
}

export interface AgentMessage {
  version: 2;
  projectId: string;
  messageId: string;
  conversationId: string;
  from: string;
  to: string;
  inReplyTo: string | null;
  kind: "message" | "reply" | "close";
  text: string;
  turn: number;
  maxTurns: number;
  finished: boolean;
}

export interface MessageReceipt {
  messageId: string;
  projectId: string;
  from: string;
  to: string;
  accepted: true;
  duplicate: boolean;
  receivedAt: string;
}

export function newAgentId(): string {
  return `omp-${randomBytes(8).toString("hex")}`;
}

export function newConversationId(): string {
  return `chat-${randomBytes(16).toString("hex")}`;
}

export function newMessageId(): string {
  return `msg-${randomBytes(16).toString("hex")}`;
}

export function validateMessage(value: unknown): asserts value is AgentMessage {
  if (!value || typeof value !== "object") throw new Error("Invalid message envelope");
  const m = value as Record<string, unknown>;
  if (
    m.version !== PROTOCOL_VERSION ||
    typeof m.projectId !== "string" || !PROJECT_ID_PATTERN.test(m.projectId) ||
    typeof m.messageId !== "string" || !MESSAGE_ID_PATTERN.test(m.messageId) ||
    typeof m.conversationId !== "string" || !CONVERSATION_ID_PATTERN.test(m.conversationId) ||
    typeof m.from !== "string" || !AGENT_ID_PATTERN.test(m.from) ||
    typeof m.to !== "string" || !AGENT_ID_PATTERN.test(m.to) ||
    m.from === m.to ||
    (m.inReplyTo !== null && (typeof m.inReplyTo !== "string" || !MESSAGE_ID_PATTERN.test(m.inReplyTo))) ||
    !["message", "reply", "close"].includes(m.kind as string) ||
    typeof m.text !== "string" || !m.text.trim() || Buffer.byteLength(m.text) > MAX_TEXT_BYTES ||
    !Number.isInteger(m.maxTurns) || (m.maxTurns as number) < 1 || (m.maxTurns as number) > MAX_TURNS ||
    !Number.isInteger(m.turn) || (m.turn as number) < 0 || (m.turn as number) > (m.maxTurns as number) ||
    typeof m.finished !== "boolean"
  ) throw new Error("Invalid message fields, address, or size");
  if (m.kind === "message" && (m.turn !== 0 || m.inReplyTo !== null || m.finished)) {
    throw new Error("An initial message must start at turn zero");
  }
  if (m.kind === "reply" && (m.inReplyTo === null || m.turn === 0 || (m.turn === m.maxTurns && !m.finished))) {
    throw new Error("A reply requires correlation and must respect the turn limit");
  }
  if (m.kind === "close" && !m.finished) throw new Error("A close message must be terminal");
}
