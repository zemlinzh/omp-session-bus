import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { AgentMessage } from "./protocol";

type QueuedMessage = ReturnType<AgentSession["agent"]["peekFollowUpQueue"]>[number];
type CustomPrompt = Parameters<AgentSession["promptCustomMessage"]>[0];

export type QueuedPromptHost = Pick<AgentSession, "isStreaming" | "promptCustomMessage"> & {
  agent: Pick<AgentSession["agent"], "peekSteeringQueue" | "peekFollowUpQueue" | "peekUndeliveredQueuedMessages" | "replaceQueue" | "prioritizeSteering" | "popLastSteer" | "popLastFollowUp" | "steer" | "followUp" | "moveFollowUpsToSteering" | "addBeforeQueuedMessageDequeueHook">;
};

interface Registration {
  messageId: string;
  conversationId: string;
  active: boolean;
  queued?: readonly QueuedMessage[];
}

/** Owns only reply-required notifications, never user input or terminal results. */
export class QueuedPeerPrompts {
  readonly #registrations = new Map<string, Registration>();
  readonly #bindings = new WeakMap<QueuedMessage, Registration>();
  readonly #detach: () => void;
  #active = true;

  constructor(private readonly host: QueuedPromptHost, private readonly isPending: (messageId: string) => boolean) {
    this.#detach = host.agent.addBeforeQueuedMessageDequeueHook(() => this.#prune());
  }

  async submit(message: AgentMessage, payload: CustomPrompt): Promise<void> {
    const registration: Registration = { messageId: message.messageId, conversationId: message.conversationId, active: true };
    this.#registrations.set(message.messageId, registration);
    const wasBusy = this.host.isStreaming;
    try {
      // queueOnly closes the direct-idle-prompt admission path. The callback is
      // synchronous after normalization/insertion and before drain scheduling.
      await this.host.promptCustomMessage(payload, {
        queueOnly: true,
        streamingBehavior: "followUp",
        onPromptQueued: queued => {
          registration.queued = queued;
          for (const item of queued) this.#bindings.set(item, registration);
          if (!this.#live(registration)) {
            this.#retire(registration);
            return;
          }
          // A fresh idle session may have no assistant/tool tail to continue.
          // Decide at admission, not before an asynchronous normalization, so
          // this never steers a newly started foreground tool batch.
          if (!wasBusy && !this.host.isStreaming) {
            const owned = new Set(queued);
            this.host.agent.moveFollowUpsToSteering(
              this.host.agent.peekFollowUpQueue().filter(item => !owned.has(item)),
              queued,
            );
          }
        },
      });
    } catch (error) {
      this.#retire(registration);
      throw error;
    }
  }

  cancelMessage(messageId: string): void {
    const registration = this.#registrations.get(messageId);
    if (registration) this.#retire(registration);
  }

  cancelConversation(conversationId: string): void {
    for (const registration of this.#registrations.values()) {
      if (registration.conversationId === conversationId) this.#retire(registration);
    }
  }

  cancelAll(): void {
    for (const registration of this.#registrations.values()) this.#retire(registration);
  }

  dispose(): void {
    if (!this.#active) return;
    this.#active = false;
    this.cancelAll();
    this.#detach();
  }

  #live(registration: Registration): boolean {
    return this.#active && registration.active && this.isPending(registration.messageId);
  }

  #retire(registration: Registration): void {
    registration.active = false;
    this.#registrations.delete(registration.messageId);
    this.#dropPresent(registration.queued);
  }

  #dropPresent(queued: readonly QueuedMessage[] | undefined): void {
    if (!queued?.length) return;
    this.#dropTargets(new Set(queued));
  }

  #dropTargets(targets: ReadonlySet<QueuedMessage>): void {
    const canReplace = this.host.agent.peekUndeliveredQueuedMessages().length === 0;
    for (const name of ["steering", "followUp"] as const) {
      let pending = name === "steering" ? this.host.agent.peekSteeringQueue() : this.host.agent.peekFollowUpQueue();
      let first = pending.findIndex(item => targets.has(item));
      if (first < 0) continue;
      if (canReplace) {
        // One transition leaves retained user identities continuously visible;
        // no already-dequeued recovery records exist to be invalidated here.
        this.host.agent.replaceQueue(name, pending.filter(item => !targets.has(item)));
        continue;
      }
      if (name === "steering") {
        this.host.agent.prioritizeSteering(pending.filter(item => !targets.has(item)));
        pending = this.host.agent.peekSteeringQueue();
        first = pending.findIndex(item => targets.has(item));
        if (first < 0) continue;
      }
      const retained: QueuedMessage[] = [];
      // Replacement clears the host's already-dequeued recovery records.
      // Pop only the affected suffix, then restore non-target objects in their
      // original order. No await lets another model batch interleave here.
      for (let count = pending.length - first; count > 0; count--) {
        const item = name === "steering" ? this.host.agent.popLastSteer() : this.host.agent.popLastFollowUp();
        if (item && !targets.has(item)) retained.push(item);
      }
      for (let index = retained.length - 1; index >= 0; index--) {
        if (name === "steering") this.host.agent.steer(retained[index]);
        else this.host.agent.followUp(retained[index]);
      }
    }
  }

  #prune(): void {
    const targets: QueuedMessage[] = [];
    for (const item of [...this.host.agent.peekSteeringQueue(), ...this.host.agent.peekFollowUpQueue()]) {
      const registration = this.#bindings.get(item);
      if (!registration || this.#live(registration)) continue;
      registration.active = false;
      this.#registrations.delete(registration.messageId);
      targets.push(item);
    }
    // Weak bindings survive withdrawal so a host-restored queued object cannot
    // resurrect an answered request; delivered history is deliberately untouched.
    if (targets.length) this.#dropTargets(new Set(targets));
  }
}
