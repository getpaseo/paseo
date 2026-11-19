import { AgentTurnBusyError, type PromptDispatchDisposition } from "../agent-prompt.js";
import { randomUUID } from "node:crypto";
import type { AgentPromptInput, AgentPromptContentBlock } from "../agent-sdk-types.js";
import { prepareAgentMessage, type AgentPromptSource } from "./envelope.js";

interface Message {
  recipientId: string;
  messageId?: string;
  source: AgentPromptSource;
  prompt: AgentPromptInput;
  sessionMode?: string;
  unarchive?: boolean;
  /** Wait for an idle turn and discard the message if shutdown starts before handoff. */
  idleOnly?: true;
  clearPendingPermissions?: boolean;
  activeTurnBehavior?: "steer" | "interrupt";
  beforeDispatch?: () => void;
  onDispatch?: (disposition: PromptDispatchDisposition) => void;
}
interface Receipt {
  status: "queued";
  messageId: string;
  dispatched: Promise<PromptDispatchDisposition>;
}
interface Admitted extends Message {
  sequence: number;
  state: "queued" | "claimed" | "withdrawn";
  outOfBandDeclined: boolean;
  receipt: Receipt;
  resolve(disposition: PromptDispatchDisposition): void;
  reject(error: unknown): void;
}
interface DispatchRequest {
  recipientId: string;
  messageIds: readonly string[];
  prompt: AgentPromptInput;
  activeTurnBehavior: "steer" | "interrupt";
  idleOnly: boolean;
  sessionMode?: string;
  clearPendingPermissions: boolean;
  unarchive: boolean;
}
interface Dependencies {
  /** Includes admitted starts and provider turns, including compaction. */
  isRunning?: (recipientId: string) => boolean;
  hasPendingPermission?: (recipientId: string) => boolean;
  /** Notify when recipient state changes; admission still checks whether it is idle. */
  subscribe?: (listener: (recipientId: string) => void) => () => void;
  tryRunOutOfBand?(request: DispatchRequest, onAccepted: () => void): Promise<boolean>;
  dispatch(request: DispatchRequest): Promise<PromptDispatchDisposition>;
  onError(error: unknown, request: DispatchRequest): void;
  /** Return a cancellation function. Production uses the daemon's event loop. */
  schedule?: (delayMs: number, callback: () => void) => () => void;
}
export interface AgentMessageDelivery {
  enqueue(message: Message): Receipt;
  /** Remove matching messages that the queue still owns before dispatcher handoff. */
  withdrawPending(recipientId: string, matches: (source: AgentPromptSource) => boolean): number;
  /** Queued messages and provider dispatches still owned by this recipient. */
  hasPending(recipientId: string): boolean;
  /** Stop admission, flush pending messages, and await provider dispatch acknowledgments. */
  close(): Promise<void>;
  /** Completion waits include admitted messages, but return at permission checkpoints. */
  waitForDispatch(recipientId: string, signal: AbortSignal): Promise<void>;
}

/** Recipient-owned agent delivery. Human prompts never enter this module. */
export function createAgentMessageDelivery(dependencies: Dependencies): AgentMessageDelivery {
  const schedule =
    dependencies.schedule ??
    ((delayMs, callback) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });
  const pending = new Map<string, { messages: Admitted[]; ready: boolean; cancel(): void }>();
  const dispatching = new Map<string, Promise<void>>();
  const admitted = new Map<string, Set<Admitted>>();
  let sequence = 0;
  let closed = false;
  let closing: Promise<void> | undefined;

  function requestFor(recipientId: string, messages: Admitted[]): DispatchRequest {
    const prompts = messages.map(
      (message) =>
        prepareAgentMessage(message.prompt, message.source, message.receipt.messageId).prompt,
    );
    const prompt: AgentPromptInput = prompts.every((entry) => typeof entry === "string")
      ? prompts.join("\n\n")
      : prompts.flatMap((entry): AgentPromptContentBlock[] =>
          typeof entry === "string" ? [{ type: "text", text: entry }] : entry,
        );
    return {
      recipientId,
      idleOnly:
        messages.some((message) => message.idleOnly) ||
        (!closed && messages[0]!.activeTurnBehavior !== "interrupt"),
      messageIds: messages.map((message) => message.receipt.messageId),
      prompt,
      activeTurnBehavior: messages[0]!.activeTurnBehavior ?? "steer",
      sessionMode: messages.find((message) => message.sessionMode)?.sessionMode,
      clearPendingPermissions: messages.some((message) => message.clearPendingPermissions),
      unarchive: messages.some((message) => message.unarchive !== false),
    };
  }

  function withdraw(message: Admitted): void {
    message.state = "withdrawn";
    message.reject(new DOMException("Agent message withdrawn", "AbortError"));
  }

  function withdrawPending(recipientId: string, matches: (message: Admitted) => boolean): number {
    let removed = 0;
    for (const message of admitted.get(recipientId) ?? []) {
      if (message.state !== "queued" || !matches(message)) continue;
      withdraw(message);
      removed++;
    }
    const entry = pending.get(recipientId);
    if (entry && removed) {
      entry.messages = entry.messages.filter((message) => message.state !== "withdrawn");
      if (!entry.messages.length) {
        entry.cancel();
        pending.delete(recipientId);
      }
    }
    return removed;
  }

  function readyToDispatch(recipientId: string, batch: Admitted[]): Admitted[] {
    const queued = batch.filter((message) => message.state === "queued");
    if (closed || !dependencies.hasPendingPermission?.(recipientId)) return queued;
    const waiting = queued.filter((message) => message.idleOnly);
    if (waiting.length) requeue(recipientId, waiting);
    return queued.filter((message) => !message.idleOnly);
  }

  function dispatch(recipientId: string, batch: Admitted[]): void {
    queueDispatch(recipientId, async () => {
      let messages = readyToDispatch(recipientId, batch);
      if (!messages.length) return;
      let request = requestFor(recipientId, messages);
      for (const message of messages) message.state = "claimed";
      try {
        for (const message of messages) message.beforeDispatch?.();
        let disposition: PromptDispatchDisposition;
        try {
          disposition = await dependencies.dispatch(request);
        } catch (error) {
          if (!(error instanceof AgentTurnBusyError) || !closed) throw error;
          // Shutdown may still dispatch peer messages. Idle-only messages never join a steer.
          for (const message of messages) {
            if (message.idleOnly) withdraw(message);
          }
          messages = messages.filter((message) => message.state !== "withdrawn");
          if (!messages.length) return;
          request = requestFor(recipientId, messages);
          disposition = await dependencies.dispatch(request);
        }
        for (const message of messages) {
          try {
            message.onDispatch?.(disposition);
          } catch (error) {
            dependencies.onError(error, request);
          }
          message.resolve(disposition);
        }
      } catch (error) {
        if (error instanceof AgentTurnBusyError && !closed) {
          requeue(recipientId, messages);
          return;
        }
        for (const message of messages) message.reject(error);
        dependencies.onError(error, request);
        throw error;
      }
    });
  }

  function queueDispatch(recipientId: string, operation: () => Promise<void>): void {
    const previous = dispatching.get(recipientId) ?? Promise.resolve();
    const dispatched = previous.catch(() => undefined).then(operation);
    dispatching.set(recipientId, dispatched);
    void dispatched
      .finally(() => {
        if (dispatching.get(recipientId) === dispatched) dispatching.delete(recipientId);
      })
      .catch(() => undefined);
  }

  function requeue(recipientId: string, messages: Admitted[]): void {
    for (const message of messages) message.state = "queued";
    const entry = pending.get(recipientId) ?? {
      messages: [],
      ready: true,
      cancel: () => {},
    };
    entry.cancel();
    entry.messages.push(...messages);
    entry.messages.sort((a, b) => a.sequence - b.sequence);
    entry.cancel = schedule(2000, () => flush(recipientId));
    pending.set(recipientId, entry);
  }

  function flush(recipientId: string): void {
    const entry = pending.get(recipientId);
    if (!entry) return;
    entry.ready = true;
    entry.cancel();
    if (!closed && dependencies.isRunning?.(recipientId)) {
      const interrupts = entry.messages.filter(
        (message) => message.activeTurnBehavior === "interrupt",
      );
      entry.messages = entry.messages.filter(
        (message) => message.activeTurnBehavior !== "interrupt",
      );
      if (interrupts.length) dispatchGroups(recipientId, interrupts);
      if (entry.messages.length && dependencies.tryRunOutOfBand) {
        pending.delete(recipientId);
        offerOutOfBand(recipientId, entry.messages);
      } else if (entry.messages.length) {
        entry.cancel = schedule(2000, () => flush(recipientId));
      } else {
        pending.delete(recipientId);
      }
      return;
    }
    pending.delete(recipientId);
    dispatchGroups(recipientId, entry.messages);
  }

  function offerOutOfBand(recipientId: string, messages: Admitted[]): void {
    queueDispatch(recipientId, async () => {
      const waiting: Admitted[] = [];
      for (const message of messages) {
        if (message.state === "withdrawn") continue;
        if (
          message.idleOnly ||
          message.outOfBandDeclined ||
          message.sessionMode !== undefined ||
          closed ||
          !dependencies.isRunning?.(recipientId)
        ) {
          waiting.push(message);
          continue;
        }
        const request = requestFor(recipientId, [message]);
        message.state = "claimed";
        try {
          const accepted = await dependencies.tryRunOutOfBand!(request, () =>
            message.beforeDispatch?.(),
          );
          if (!accepted) {
            message.outOfBandDeclined = true;
            message.state = "queued";
            waiting.push(message);
            continue;
          }
          try {
            message.onDispatch?.("out_of_band");
          } catch (error) {
            dependencies.onError(error, request);
          }
          message.resolve("out_of_band");
        } catch (error) {
          message.reject(error);
          dependencies.onError(error, request);
        }
      }
      if (waiting.length) requeue(recipientId, waiting);
      if (closed || (pending.get(recipientId)?.ready && !dependencies.isRunning?.(recipientId)))
        flush(recipientId);
    });
  }

  function dispatchGroups(recipientId: string, messages: Admitted[]): void {
    const groups: Admitted[][] = [];
    let group: Admitted[] = [];
    let mode: string | undefined;
    for (const message of messages) {
      // Explicitly conflicting send options require separate, ordered dispatches.
      if (
        group.length &&
        ((message.activeTurnBehavior ?? "steer") !== (group[0]!.activeTurnBehavior ?? "steer") ||
          (mode && message.sessionMode && mode !== message.sessionMode))
      ) {
        groups.push(group);
        group = [];
        mode = undefined;
      }
      group.push(message);
      mode ??= message.sessionMode;
    }
    if (group.length) groups.push(group);
    let started = false;
    for (const batch of groups) {
      if (!closed && started && batch[0]!.activeTurnBehavior !== "interrupt") {
        requeue(recipientId, batch);
      } else {
        dispatch(recipientId, batch);
        started = true;
      }
    }
  }

  const unsubscribe = dependencies.subscribe?.((recipientId) => {
    if (pending.get(recipientId)?.ready && !dependencies.isRunning?.(recipientId))
      flush(recipientId);
  });

  return {
    withdrawPending: (recipientId, matches) =>
      withdrawPending(recipientId, (message) => matches(message.source)),
    hasPending: (recipientId) => pending.has(recipientId) || dispatching.has(recipientId),
    enqueue(message) {
      if (closed) throw new Error("Agent message delivery is closed");
      let resolve!: Admitted["resolve"];
      let reject!: Admitted["reject"];
      const dispatched = new Promise<PromptDispatchDisposition>((accepted, failed) => {
        resolve = accepted;
        reject = failed;
      });
      void dispatched.catch(() => undefined);
      const receipt: Receipt = {
        status: "queued",
        messageId: message.messageId ?? randomUUID(),
        dispatched,
      };
      const item: Admitted = {
        ...message,
        receipt,
        resolve,
        reject,
        sequence: sequence++,
        state: "queued",
        outOfBandDeclined: false,
      };
      const owned = admitted.get(message.recipientId) ?? new Set<Admitted>();
      owned.add(item);
      admitted.set(message.recipientId, owned);
      void dispatched
        .finally(() => {
          owned.delete(item);
          if (!owned.size) admitted.delete(message.recipientId);
        })
        .catch(() => undefined);
      const entry = pending.get(message.recipientId) ?? {
        messages: [],
        ready: false,
        cancel: () => {},
      };
      entry.cancel();
      entry.ready = false;
      entry.messages.push(item);
      entry.cancel = schedule(2000, () => flush(message.recipientId));
      pending.set(message.recipientId, entry);
      return receipt;
    },
    async waitForDispatch(recipientId, signal) {
      signal.throwIfAborted();
      const waiting = Array.from(admitted.get(recipientId) ?? [], (message) =>
        message.receipt.dispatched.catch((error) => {
          if (message.state !== "withdrawn") throw error;
          return undefined;
        }),
      );
      let unsubscribePermission: (() => void) | undefined;
      const permission = new Promise<void>((resolve) => {
        const check = () => {
          if (dependencies.hasPendingPermission?.(recipientId)) resolve();
        };
        unsubscribePermission = dependencies.subscribe?.((agentId) => {
          if (agentId === recipientId) check();
        });
        check();
      });
      let aborted!: () => void;
      const cancellation = new Promise<never>((_resolve, reject) => {
        aborted = () => reject(new DOMException("Wait aborted", "AbortError"));
        signal.addEventListener("abort", aborted, { once: true });
      });
      try {
        await Promise.race([
          Promise.all([dispatching.get(recipientId), ...waiting]),
          cancellation,
          permission,
        ]);
      } finally {
        signal.removeEventListener("abort", aborted);
        unsubscribePermission?.();
      }
    },
    close() {
      if (closing) return closing;
      closed = true;
      unsubscribe?.();
      for (const recipientId of admitted.keys()) {
        withdrawPending(recipientId, (message) => message.idleOnly === true);
      }
      for (const recipientId of pending.keys()) flush(recipientId);
      // Each failure is reported and rejects its receipts; shutdown still drains other recipients.
      closing = Promise.allSettled(
        [...admitted.values()].flatMap((owned) =>
          [...owned].map((message) => message.receipt.dispatched),
        ),
      ).then(() => undefined);
      return closing;
    },
  };
}
