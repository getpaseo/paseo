import {
  AgentTurnBusyError,
  type PromptDispatchDisposition,
  type PromptDispatchResult,
} from "../agent-prompt.js";
import { randomUUID } from "node:crypto";
import type { AgentPromptInput, AgentPromptContentBlock } from "../agent-sdk-types.js";
import { envelopeMessage, prepareAgentMessage, type AgentPromptSource } from "./envelope.js";

/** A message's quiet window closes this long after the latest arrival. */
const QUIET_MS = 2000;
/** Steady arrivals cannot keep a quiet window open longer than this. */
const MAX_COLLECTING_MS = 10_000;

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
  state: "queued" | "claimed" | "withdrawn" | "rejected";
  outOfBandDeclined: boolean;
  receipt: Receipt;
  resolve(disposition: PromptDispatchDisposition): void;
  reject(error: unknown): void;
}
/**
 * A recipient's queue. A dispatch in flight for the recipient is its entry in `releasing`:
 * collecting → waiting → releasing, and Stop moves either of the first two to held.
 */
interface Inbox {
  /** Admission order. A message leaves when a dispatch claims it or it is withdrawn. */
  messages: Admitted[];
  phase:
    | "collecting" // The quiet window is open.
    | "waiting" // The window closed; released as soon as the recipient is idle.
    | "held"; // A Stop held it; released with the recipient's next prompt.
  /** The quiet window while collecting, the busy retry while waiting. */
  cancelTimer(): void;
  cancelCap(): void;
  /** An advance is already in line behind the recipient's current operation. */
  advancing: boolean;
}
interface DispatchRequest {
  recipientId: string;
  messageIds: readonly string[];
  prompt: AgentPromptInput;
  activeTurnBehavior: "steer" | "interrupt";
  idleOnly: boolean;
  /** Claim this exact prompt at provider admission. A withdrawn message invalidates the batch. */
  admit(): boolean;
  sessionMode?: string;
  clearPendingPermissions: boolean;
  unarchive: boolean;
}
/** A prompt that does not wait its turn: a person's, or the daemon's own. */
interface DirectPrompt {
  recipientId: string;
  prompt: AgentPromptInput;
  source?: AgentPromptSource;
  messageId?: string;
  sessionMode?: string;
  unarchive?: boolean;
}
/** The provider prompt a direct prompt became. Unchanged when nothing was queued. */
interface JoinedPrompt {
  prompt: AgentPromptInput;
  messageId?: string;
  sessionMode?: string;
  unarchive: boolean;
}
interface Dependencies {
  /** Includes admitted starts and provider turns, including compaction. */
  isRunning?: (recipientId: string) => boolean;
  hasPendingPermission?: (recipientId: string) => boolean;
  /** Notify when recipient state changes; admission still checks whether it is idle. */
  subscribe?: (listener: (recipientId: string) => void) => () => void;
  /** Notify before a recipient's turn is stopped with no prompt replacing it. */
  onStop?: (listener: (recipientId: string) => void) => () => void;
  tryRunOutOfBand?(request: DispatchRequest, onAccepted: () => void): Promise<boolean>;
  dispatch(request: DispatchRequest): Promise<PromptDispatchDisposition>;
  onError(error: unknown, request: DispatchRequest): void;
  /** Return a cancellation function. Production uses the daemon's event loop. */
  schedule?: (delayMs: number, callback: () => void) => () => void;
}
export interface AgentMessageDelivery {
  /** Admit a message that waits its turn. An interrupt releases at once, with everything queued. */
  enqueue(message: Message): Receipt;
  /**
   * Send a prompt that does not wait its turn. Every queued message goes ahead of it in the
   * same provider prompt, so none starts a turn of its own afterwards. A command travels alone.
   */
  sendDirect<Result extends PromptDispatchResult>(
    direct: DirectPrompt,
    send: (joined: JoinedPrompt) => Promise<Result>,
  ): Promise<Result>;
  /** Remove matching messages that the queue still owns before dispatcher handoff. */
  withdrawPending(recipientId: string, matches: (source: AgentPromptSource) => boolean): number;
  /** Messages and dispatches that will proceed without a new prompt. Held messages do not count. */
  hasPending(recipientId: string): boolean;
  /** Stop admission, flush pending messages, and await provider dispatch acknowledgments. */
  close(): Promise<void>;
  /** Completion waits include admitted messages, but return at permission checkpoints and holds. */
  waitForDispatch(recipientId: string, signal: AbortSignal): Promise<void>;
}

const isQueued = (message: Admitted): boolean => message.state === "queued";
const isWithdrawn = (message: Admitted): boolean => message.state === "withdrawn";

/** Providers parse a command from the raw text at the start of the prompt. */
function isCommand(prompt: AgentPromptInput): boolean {
  const first = typeof prompt === "string" ? prompt : prompt[0];
  if (typeof first === "string") return first.trimStart().startsWith("/");
  return first?.type === "text" && first.text.trimStart().startsWith("/");
}

function combine(prompts: AgentPromptInput[]): AgentPromptInput {
  return prompts.every((entry) => typeof entry === "string")
    ? prompts.join("\n\n")
    : prompts.flatMap((entry): AgentPromptContentBlock[] =>
        typeof entry === "string" ? [{ type: "text", text: entry }] : entry,
      );
}

function envelope(message: Admitted): AgentPromptInput {
  return prepareAgentMessage(message.prompt, message.source, message.receipt.messageId).prompt;
}

/** Explicitly conflicting session modes require separate, ordered dispatches. */
function modeGroups(messages: Admitted[]): Admitted[][] {
  const groups: Admitted[][] = [];
  let group: Admitted[] = [];
  let mode: string | undefined;
  for (const message of messages) {
    if (mode && message.sessionMode && mode !== message.sessionMode) {
      groups.push(group);
      group = [];
      mode = undefined;
    }
    group.push(message);
    mode ??= message.sessionMode;
  }
  if (group.length) groups.push(group);
  return groups;
}

/**
 * Owns the order in which prompts reach a recipient. Delivery order equals admission order:
 * only a prefix of the queue is ever dispatched, except a command a provider runs out of band.
 */
export function createAgentMessageDelivery(dependencies: Dependencies): AgentMessageDelivery {
  const schedule =
    dependencies.schedule ??
    ((delayMs, callback) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });
  const inboxes = new Map<string, Inbox>();
  const releasing = new Map<string, Promise<void>>();
  const admitted = new Map<string, Set<Admitted>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const isRunning = (recipientId: string): boolean =>
    Boolean(dependencies.isRunning?.(recipientId));

  function requestFor(
    recipientId: string,
    messages: Admitted[],
    idleOnly: boolean,
  ): DispatchRequest {
    return {
      recipientId,
      idleOnly,
      admit() {
        if (messages.some(isWithdrawn)) return false;
        for (const message of messages) message.state = "claimed";
        return true;
      },
      messageIds: messages.map((message) => message.receipt.messageId),
      prompt: combine(messages.map(envelope)),
      activeTurnBehavior: messages.some((message) => message.activeTurnBehavior === "interrupt")
        ? "interrupt"
        : "steer",
      // An interrupt may follow a message that asked for another mode; the latest choice wins.
      sessionMode: messages.findLast((message) => message.sessionMode)?.sessionMode,
      clearPendingPermissions: messages.some((message) => message.clearPendingPermissions),
      unarchive: messages.some((message) => message.unarchive !== false),
    };
  }

  function leave(message: Admitted): void {
    const messages = inboxes.get(message.recipientId)?.messages;
    const index = messages?.indexOf(message) ?? -1;
    if (index >= 0) messages!.splice(index, 1);
  }

  /** The message reached its end: dispatched, failed, or withdrawn. */
  function settle(message: Admitted, state: "claimed" | "rejected" | "withdrawn"): void {
    message.state = state;
    leave(message);
    const owned = admitted.get(message.recipientId);
    owned?.delete(message);
    if (!owned?.size) admitted.delete(message.recipientId);
  }

  function claim(
    message: Admitted,
    disposition: PromptDispatchDisposition,
    request: DispatchRequest,
  ): void {
    settle(message, "claimed");
    try {
      message.onDispatch?.(disposition);
    } catch (error) {
      dependencies.onError(error, request);
    }
    message.resolve(disposition);
  }

  /** A dispatch that did not happen returns the messages it had claimed to the queue. */
  function handBack(messages: Admitted[]): void {
    for (const message of messages) if (message.state === "claimed") message.state = "queued";
  }

  function fail(message: Admitted, error: unknown): void {
    settle(message, "rejected");
    message.reject(error);
  }

  /** One operation per recipient at a time, whether the queue or a person started it. */
  function serialize<Result>(
    recipientId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = releasing.get(recipientId) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => rest(recipientId));
    const tracked = result.then(() => undefined);
    releasing.set(recipientId, tracked);
    void tracked
      .finally(() => {
        if (releasing.get(recipientId) === tracked) releasing.delete(recipientId);
      })
      .catch(() => undefined);
    return result;
  }

  function run(recipientId: string, operation: () => Promise<void>): void {
    void serialize(recipientId, operation).catch(() => undefined);
  }

  /** After an operation: retire an empty inbox, and keep a waiting one polling. */
  function rest(recipientId: string): void {
    const inbox = inboxes.get(recipientId);
    if (!inbox) return;
    if (!inbox.messages.length) {
      retire(recipientId, inbox);
    } else if (inbox.phase === "waiting" && !inbox.advancing) {
      inbox.cancelTimer();
      inbox.cancelTimer = schedule(QUIET_MS, () => attempt(recipientId));
    }
  }

  function retire(recipientId: string, inbox: Inbox): void {
    inbox.cancelTimer();
    inbox.cancelCap();
    if (inboxes.get(recipientId) === inbox) inboxes.delete(recipientId);
  }

  /** Dispatch one batch. An idle-only batch that finds the recipient busy stays queued. */
  async function deliver(recipientId: string, batch: Admitted[], idleOnly: boolean): Promise<void> {
    for (;;) {
      const messages = batch.filter(isQueued);
      if (!messages.length) return;
      const request = requestFor(recipientId, messages, idleOnly && !closed);
      try {
        for (const message of messages) message.beforeDispatch?.();
        let disposition: PromptDispatchDisposition;
        try {
          disposition = await dependencies.dispatch(request);
        } catch (error) {
          if (!(error instanceof AgentTurnBusyError) || !closed || messages.some(isWithdrawn))
            throw error;
          // Shutdown drains admitted messages before closing the recipients.
          disposition = await dependencies.dispatch({ ...request, idleOnly: false });
        }
        for (const message of messages) claim(message, disposition, request);
        return;
      } catch (error) {
        // A withdrawal invalidated this exact prompt; the rest goes again without it.
        if (messages.some(isWithdrawn)) {
          handBack(messages);
          continue;
        }
        if (error instanceof AgentTurnBusyError && request.idleOnly) {
          handBack(messages);
          return;
        }
        for (const message of messages) fail(message, error);
        dependencies.onError(error, request);
        throw error;
      }
    }
  }

  const isOfferable = (message: Admitted): boolean =>
    isQueued(message) && !message.outOfBandDeclined && message.sessionMode === undefined;

  /** A provider may run a waiting command without ending the turn. Each message is offered once. */
  async function offerOutOfBand(recipientId: string, inbox: Inbox): Promise<void> {
    for (const message of inbox.messages.filter(isOfferable)) {
      if (closed || inbox.phase !== "waiting" || !isRunning(recipientId)) return;
      if (!isOfferable(message)) continue;
      const request = requestFor(recipientId, [message], true);
      try {
        const accepted = await dependencies.tryRunOutOfBand!(request, () => {
          if (!request.admit()) throw new Error("Queued agent message was withdrawn");
          message.beforeDispatch?.();
        });
        if (accepted) claim(message, "out_of_band", request);
        else message.outOfBandDeclined = true;
      } catch (error) {
        if (isWithdrawn(message)) continue;
        fail(message, error);
        dependencies.onError(error, request);
      }
    }
  }

  /** Move a waiting queue forward: commands while the turn runs, the queue once it has ended. */
  async function advance(recipientId: string, inbox: Inbox): Promise<void> {
    if (inbox.phase !== "waiting") return;
    if (dependencies.tryRunOutOfBand && isRunning(recipientId))
      await offerOutOfBand(recipientId, inbox);
    // Later mode groups stay queued for the turn ends that follow.
    if (inbox.phase === "waiting" && !isRunning(recipientId))
      await deliver(recipientId, modeGroups(inbox.messages)[0] ?? [], true);
  }

  /** The quiet window closed, a retry came due, or the recipient settled. */
  function attempt(recipientId: string): void {
    const inbox = inboxes.get(recipientId);
    if (!inbox || inbox.phase === "held") return;
    inbox.cancelTimer();
    inbox.cancelCap();
    inbox.phase = "waiting";
    const running = isRunning(recipientId);
    if (running) inbox.cancelTimer = schedule(QUIET_MS, () => attempt(recipientId));
    const nothingToOffer = !dependencies.tryRunOutOfBand || !inbox.messages.some(isOfferable);
    if (inbox.advancing || (running && nothingToOffer)) return;
    inbox.advancing = true;
    run(recipientId, () => {
      inbox.advancing = false;
      return advance(recipientId, inbox);
    });
  }

  function collect(item: Admitted): void {
    const existing = inboxes.get(item.recipientId);
    const inbox = existing ?? {
      messages: [],
      phase: "collecting",
      cancelTimer: () => {},
      cancelCap: () => {},
      advancing: false,
    };
    inboxes.set(item.recipientId, inbox);
    inbox.messages.push(item);
    inbox.cancelTimer();
    inbox.cancelTimer = schedule(QUIET_MS, () => attempt(item.recipientId));
    if (existing?.phase === "collecting") return;
    // A new window. It closes after a quiet spell, and no later than the cap.
    inbox.phase = "collecting";
    inbox.cancelCap = schedule(MAX_COLLECTING_MS, () => attempt(item.recipientId));
  }

  /** Everything the recipient's queue holds, leaving it empty. */
  function take(recipientId: string): Admitted[] {
    const inbox = inboxes.get(recipientId);
    if (!inbox) return [];
    retire(recipientId, inbox);
    return inbox.messages.splice(0);
  }

  function join(queued: Admitted[], direct: DirectPrompt): JoinedPrompt {
    if (!queued.length) {
      const own = prepareAgentMessage(direct.prompt, direct.source, direct.messageId);
      return {
        prompt: own.prompt,
        messageId: own.messageId,
        sessionMode: direct.sessionMode,
        unarchive: direct.unarchive !== false,
      };
    }
    // Sharing a prompt with agent messages, a person's text needs its own envelope to stay
    // a separate row with its own identity.
    const own = envelopeMessage(direct.prompt, direct.source ?? null, direct.messageId);
    return {
      prompt: combine([...queued.map(envelope), own.prompt]),
      messageId: own.messageId,
      sessionMode:
        direct.sessionMode ?? queued.findLast((message) => message.sessionMode)?.sessionMode,
      unarchive:
        direct.unarchive !== false || queued.some((message) => message.unarchive !== false),
    };
  }

  /** Receipts of messages that rode a direct prompt follow that prompt's start. */
  function followStart(queued: Admitted[], result: PromptDispatchResult): void {
    if (!queued.length) return;
    const request = requestFor(queued[0]!.recipientId, queued, false);
    const started = result.disposition === "turn_started" ? result.started : Promise.resolve();
    void started.then(
      () => {
        for (const message of queued) claim(message, result.disposition, request);
        return undefined;
      },
      (error: unknown) => {
        for (const message of queued) fail(message, error);
      },
    );
  }

  const unsubscribe = dependencies.subscribe?.((recipientId) => {
    if (inboxes.get(recipientId)?.phase === "waiting" && !isRunning(recipientId))
      attempt(recipientId);
  });
  const unsubscribeStop = dependencies.onStop?.((recipientId) => {
    const inbox = inboxes.get(recipientId);
    if (!inbox) return;
    // The stopped recipient stays stopped. Its queue goes with whatever prompts it next.
    inbox.cancelTimer();
    inbox.cancelCap();
    inbox.phase = "held";
  });

  return {
    withdrawPending(recipientId, matches) {
      let removed = 0;
      for (const message of admitted.get(recipientId) ?? []) {
        if (!isQueued(message) || !matches(message.source)) continue;
        settle(message, "withdrawn");
        message.reject(new DOMException("Agent message withdrawn", "AbortError"));
        removed++;
      }
      const inbox = inboxes.get(recipientId);
      if (inbox && !inbox.messages.length) retire(recipientId, inbox);
      return removed;
    },
    hasPending(recipientId) {
      const inbox = inboxes.get(recipientId);
      const held = inbox?.phase === "held" ? inbox.messages : [];
      return [...(admitted.get(recipientId) ?? [])].some((message) => !held.includes(message));
    },
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
        state: "queued",
        outOfBandDeclined: false,
      };
      const owned = admitted.get(message.recipientId) ?? new Set<Admitted>();
      owned.add(item);
      admitted.set(message.recipientId, owned);
      if (item.activeTurnBehavior === "interrupt") {
        // An interrupt does not wait and does not jump the queue: it takes the queue along.
        const batch = [...take(item.recipientId), item];
        run(item.recipientId, () => deliver(item.recipientId, batch, false));
      } else {
        collect(item);
      }
      return receipt;
    },
    async sendDirect(direct, send) {
      const outcome = await serialize(direct.recipientId, async () => {
        const queued =
          closed || isCommand(direct.prompt)
            ? []
            : (inboxes.get(direct.recipientId)?.messages.filter(isQueued) ?? []);
        // This send owns them until it settles; a failure hands them back to the queue.
        for (const message of queued) message.state = "claimed";
        try {
          for (const message of queued) message.beforeDispatch?.();
          const result = await send(join(queued, direct));
          for (const message of queued) leave(message);
          followStart(queued, result);
          return { result };
        } catch (error) {
          handBack(queued);
          return { error };
        }
      });
      if ("error" in outcome) throw outcome.error;
      return outcome.result;
    },
    async waitForDispatch(recipientId, signal) {
      signal.throwIfAborted();
      const waiting = Array.from(admitted.get(recipientId) ?? [], (message) =>
        message.receipt.dispatched.catch((error) => {
          if (message.state !== "withdrawn") throw error;
          return undefined;
        }),
      );
      let unsubscribeCheckpoint: (() => void) | undefined;
      const checkpoint = new Promise<void>((resolve) => {
        const check = () => {
          if (
            dependencies.hasPendingPermission?.(recipientId) ||
            inboxes.get(recipientId)?.phase === "held"
          )
            resolve();
        };
        unsubscribeCheckpoint = dependencies.subscribe?.((agentId) => {
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
          Promise.all([releasing.get(recipientId), ...waiting]),
          cancellation,
          checkpoint,
        ]);
      } finally {
        signal.removeEventListener("abort", aborted);
        unsubscribeCheckpoint?.();
      }
    },
    close() {
      if (closing) return closing;
      closed = true;
      unsubscribe?.();
      unsubscribeStop?.();
      for (const recipientId of inboxes.keys()) {
        for (const group of modeGroups(take(recipientId)))
          run(recipientId, () => deliver(recipientId, group, false));
      }
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
