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
  dispatch(request: DispatchRequest): Promise<PromptDispatchDisposition>;
  onError(error: unknown, request: DispatchRequest): void;
  /** Return a cancellation function. Production uses the daemon's event loop. */
  schedule?: (delayMs: number, callback: () => void) => () => void;
}
export interface AgentMessageDelivery {
  enqueue(message: Message): Receipt;
  /** Queued messages and provider dispatches still owned by this recipient. */
  hasPending(recipientId: string): boolean;
  /** Stop admission, flush pending messages, and await provider dispatch acknowledgments. */
  close(): Promise<void>;
  /** Existing completion waits include agent messages admitted before the wait. */
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
  const pending = new Map<string, { messages: Admitted[]; cancel(): void }>();
  const dispatching = new Map<string, Promise<void>>();
  const receipts = new Map<string, Set<Receipt>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  function dispatch(recipientId: string, messages: Admitted[]): void {
    const prompts = messages.map(
      (message) =>
        prepareAgentMessage(message.prompt, message.source, message.receipt.messageId).prompt,
    );
    const prompt: AgentPromptInput = prompts.every((entry) => typeof entry === "string")
      ? prompts.join("\n\n")
      : prompts.flatMap((entry): AgentPromptContentBlock[] =>
          typeof entry === "string" ? [{ type: "text", text: entry }] : entry,
        );
    const request: DispatchRequest = {
      recipientId,
      idleOnly: !closed && messages[0]!.activeTurnBehavior !== "interrupt",
      messageIds: messages.map((message) => message.receipt.messageId),
      prompt,
      activeTurnBehavior: messages[0]!.activeTurnBehavior ?? "steer",
      sessionMode: messages.find((message) => message.sessionMode)?.sessionMode,
      clearPendingPermissions: messages.some((message) => message.clearPendingPermissions),
      unarchive: messages.some((message) => message.unarchive !== false),
    };
    const previous = dispatching.get(recipientId) ?? Promise.resolve();
    const dispatched = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          for (const message of messages) message.beforeDispatch?.();
          let disposition: PromptDispatchDisposition;
          try {
            disposition = await dependencies.dispatch(request);
          } catch (error) {
            if (!(error instanceof AgentTurnBusyError) || !closed) throw error;
            // Shutdown drains admitted messages before closing the recipients.
            disposition = await dependencies.dispatch({ ...request, idleOnly: false });
          }
          for (const message of messages) {
            try {
              message.onDispatch?.(disposition);
            } catch (error) {
              dependencies.onError(error, request);
            }
            message.resolve(disposition);
          }
          return undefined;
        } catch (error) {
          if (error instanceof AgentTurnBusyError && !closed) {
            const entry = pending.get(recipientId) ?? { messages: [], cancel: () => {} };
            entry.cancel();
            entry.messages.unshift(...messages);
            entry.cancel = schedule(2000, () => flush(recipientId));
            pending.set(recipientId, entry);
            return;
          }
          for (const message of messages) message.reject(error);
          dependencies.onError(error, request);
          throw error;
        }
      });
    dispatching.set(recipientId, dispatched);
    void dispatched
      .finally(() => {
        if (dispatching.get(recipientId) === dispatched) dispatching.delete(recipientId);
      })
      .catch(() => undefined);
  }

  function flush(recipientId: string): void {
    const entry = pending.get(recipientId);
    if (!entry) return;
    entry.cancel();
    if (!closed && dependencies.isRunning?.(recipientId)) {
      const interrupts = entry.messages.filter(
        (message) => message.activeTurnBehavior === "interrupt",
      );
      entry.messages = entry.messages.filter(
        (message) => message.activeTurnBehavior !== "interrupt",
      );
      if (interrupts.length) dispatch(recipientId, interrupts);
      if (entry.messages.length) {
        entry.cancel = schedule(2000, () => flush(recipientId));
      } else {
        pending.delete(recipientId);
      }
      return;
    }
    pending.delete(recipientId);
    let group: Admitted[] = [];
    let mode: string | undefined;
    for (const message of entry.messages) {
      // Explicitly conflicting send options require separate, ordered dispatches.
      if (
        group.length &&
        ((message.activeTurnBehavior ?? "steer") !== (group[0]!.activeTurnBehavior ?? "steer") ||
          (mode && message.sessionMode && mode !== message.sessionMode))
      ) {
        dispatch(recipientId, group);
        group = [];
        mode = undefined;
      }
      group.push(message);
      mode ??= message.sessionMode;
    }
    if (group.length) dispatch(recipientId, group);
  }

  return {
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
      const owned = receipts.get(message.recipientId) ?? new Set<Receipt>();
      owned.add(receipt);
      receipts.set(message.recipientId, owned);
      void dispatched
        .finally(() => {
          owned.delete(receipt);
          if (!owned.size) receipts.delete(message.recipientId);
        })
        .catch(() => undefined);
      const entry = pending.get(message.recipientId) ?? { messages: [], cancel: () => {} };
      entry.cancel();
      entry.messages.push({ ...message, receipt, resolve, reject });
      entry.cancel = schedule(2000, () => flush(message.recipientId));
      pending.set(message.recipientId, entry);
      return receipt;
    },
    async waitForDispatch(recipientId, signal) {
      signal.throwIfAborted();
      const admitted = Array.from(receipts.get(recipientId) ?? [], (receipt) => receipt.dispatched);
      let aborted!: () => void;
      const cancellation = new Promise<never>((_resolve, reject) => {
        aborted = () => reject(new DOMException("Wait aborted", "AbortError"));
        signal.addEventListener("abort", aborted, { once: true });
      });
      try {
        await Promise.race([
          Promise.all([dispatching.get(recipientId), ...admitted]),
          cancellation,
        ]);
      } finally {
        signal.removeEventListener("abort", aborted);
      }
    },
    close() {
      if (closing) return closing;
      closed = true;
      for (const recipientId of pending.keys()) flush(recipientId);
      // Each failure is reported and rejects its receipts; shutdown still drains other recipients.
      closing = Promise.allSettled(dispatching.values()).then(() => undefined);
      return closing;
    },
  };
}
