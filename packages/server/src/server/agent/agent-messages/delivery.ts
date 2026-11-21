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
  /** claimed: a dispatch has it. It leaves the queue when the provider admits the prompt. */
  state: "queued" | "claimed" | "withdrawn" | "rejected";
  /** An interrupt that was not released yet. After a Stop it waits like any other message. */
  urgent: boolean;
  /** A Stop found it in the queue. It waits for a prompt admitted after that Stop. */
  held: boolean;
  outOfBandDeclined: boolean;
  receipt: Receipt;
  resolve(disposition: PromptDispatchDisposition): void;
  reject(error: unknown): void;
}
/**
 * A recipient's queue. A dispatch in flight for the recipient is its entry in `releasing`:
 * collecting → waiting → releasing, and Stop moves the queue to held.
 */
interface Inbox {
  /**
   * Admission order. A message stays, in its place, until the provider admits the prompt that
   * carries it, so a Stop or a later prompt always finds it here.
   */
  messages: Admitted[];
  phase:
    | "collecting" // The quiet window is open.
    | "waiting" // The window closed; released as soon as the recipient is idle.
    | "held"; // A Stop held it; released with the recipient's next prompt.
  /** The quiet window while collecting, the busy retry while waiting. */
  cancelTimer(): void;
  cancelCap(): void;
  /** A polling queue step is already in line behind the recipient's current operation. */
  advancing: boolean;
  /** Stops seen. A queue step reserved before a Stop is void, whatever is admitted afterwards. */
  stops: number;
}
interface DispatchRequest {
  recipientId: string;
  messageIds: readonly string[];
  prompt: AgentPromptInput;
  activeTurnBehavior: "steer" | "interrupt";
  idleOnly: boolean;
  /**
   * Claim this exact prompt at provider admission. A withdrawn message or a Stop that reached
   * the recipient first invalidates it.
   */
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
  /** Hand a batch to the recipient. Resolves once the provider admitted it. */
  dispatch(request: DispatchRequest): Promise<PromptDispatchDisposition>;
  /** Bound the wait for the provider to admit a direct prompt. Unbounded when absent. */
  awaitStart?(recipientId: string, started: Promise<void>): Promise<void>;
  onError(error: unknown, request: DispatchRequest): void;
  /** Return a cancellation function. Production uses the daemon's event loop. */
  schedule?: (delayMs: number, callback: () => void) => () => void;
}
export interface AgentMessageDelivery {
  /** Admit a message that waits its turn. An interrupt releases at once, with everything queued. */
  enqueue(message: Message): Receipt;
  /**
   * Send a prompt that does not wait its turn. The messages admitted before it go ahead of it
   * in the same provider prompt, so none starts a turn of its own afterwards. Its place is
   * decided by this call, whenever the recipient gets to it. A command travels alone.
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
const isUrgent = (message: Admitted): boolean => isQueued(message) && message.urgent;
const isOfferable = (message: Admitted): boolean =>
  isQueued(message) && !message.outOfBandDeclined && message.sessionMode === undefined;

/**
 * Providers read a command from the raw start of the prompt: a slash and a name with no
 * second slash in it. A path such as `/tmp/build.log` is plain text.
 */
function isCommand(prompt: AgentPromptInput): boolean {
  const first = typeof prompt === "string" ? prompt : prompt[0];
  if (typeof first !== "string" && first?.type !== "text") return false;
  const text = typeof first === "string" ? first : first.text;
  return /^\/[^\s/]+(\s|$)/.test(text.trim());
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
 *
 * Every prompt for a recipient takes its place when it is admitted, and one operation at a
 * time acts on the queue. A message stays in the queue until the provider admits the prompt
 * that carries it, so agent messages, a person's prompts, and Stop all decide over the same list.
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
  let closed = false;
  let closing: Promise<void> | undefined;

  const isRunning = (recipientId: string): boolean =>
    Boolean(dependencies.isRunning?.(recipientId));
  const isHeld = (recipientId: string): boolean => inboxes.get(recipientId)?.phase === "held";

  /** Tells whether a Stop has reached the recipient since this call. */
  function watchForStop(inbox: Inbox): () => boolean {
    const seen = inbox.stops;
    return () => inbox.stops !== seen;
  }

  function requestFor(
    recipientId: string,
    messages: Admitted[],
    idleOnly: boolean,
    stopped: () => boolean,
  ): DispatchRequest {
    return {
      recipientId,
      idleOnly,
      admit() {
        if (messages.some(isWithdrawn) || stopped()) return false;
        for (const message of messages) message.state = "claimed";
        return true;
      },
      messageIds: messages.map((message) => message.receipt.messageId),
      prompt: combine(messages.map(envelope)),
      activeTurnBehavior: messages.some((message) => message.urgent) ? "interrupt" : "steer",
      // An interrupt may follow a message that asked for another mode; the latest choice wins.
      sessionMode: messages.findLast((message) => message.sessionMode)?.sessionMode,
      clearPendingPermissions: messages.some((message) => message.clearPendingPermissions),
      unarchive: messages.some((message) => message.unarchive !== false),
    };
  }

  function retire(recipientId: string, inbox: Inbox): void {
    inbox.cancelTimer();
    inbox.cancelCap();
    if (inboxes.get(recipientId) === inbox) inboxes.delete(recipientId);
  }

  /** The message reached its end: delivered, failed, or withdrawn. */
  function settle(message: Admitted, state: "claimed" | "rejected" | "withdrawn"): void {
    message.state = state;
    const inbox = inboxes.get(message.recipientId);
    const index = inbox?.messages.indexOf(message) ?? -1;
    if (!inbox || index < 0) return;
    inbox.messages.splice(index, 1);
    if (!inbox.messages.length) retire(message.recipientId, inbox);
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

  /** A dispatch that did not happen leaves its messages queued, each still in its place. */
  function handBack(messages: Admitted[]): void {
    for (const message of messages) if (message.state === "claimed") message.state = "queued";
  }

  function fail(message: Admitted, error: unknown): void {
    settle(message, "rejected");
    message.reject(error);
  }

  /** One operation per recipient at a time, whether the queue or a person started it. */
  function run(recipientId: string, operation: () => Promise<void>): void {
    const previous = releasing.get(recipientId) ?? Promise.resolve();
    const tracked = previous
      .then(operation)
      .catch(() => undefined)
      .then(() => rest(recipientId));
    releasing.set(recipientId, tracked);
    void tracked.then(() => {
      if (releasing.get(recipientId) === tracked) releasing.delete(recipientId);
      return undefined;
    });
  }

  /** After an operation, a waiting queue keeps polling for the turn to end. */
  function rest(recipientId: string): void {
    const inbox = inboxes.get(recipientId);
    if (!inbox || inbox.advancing || inbox.phase !== "waiting") return;
    inbox.cancelTimer();
    inbox.cancelTimer = schedule(QUIET_MS, () => attempt(recipientId));
  }

  /** Dispatch one batch. A batch that finds the recipient stopped, or busy when idle-only, stays queued. */
  async function deliver(
    recipientId: string,
    batch: Admitted[],
    idleOnly: boolean,
    stopped: () => boolean,
  ): Promise<void> {
    for (;;) {
      const messages = batch.filter(isQueued);
      if (!messages.length) return;
      const request = requestFor(recipientId, messages, idleOnly && !closed, stopped);
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
        // A Stop reached the recipient before the provider admitted the prompt.
        if (stopped()) {
          handBack(messages);
          return;
        }
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

  /** A provider may run a command beside the turn. Each message is offered once, alone. */
  async function offerOutOfBand(
    recipientId: string,
    candidates: Admitted[],
    stopped: () => boolean,
    stillDue: () => boolean = () => true,
  ): Promise<void> {
    const tryRunOutOfBand = dependencies.tryRunOutOfBand;
    if (!tryRunOutOfBand) return;
    for (const message of candidates) {
      if (closed || stopped() || !stillDue()) return;
      if (!isOfferable(message)) continue;
      const request = requestFor(recipientId, [message], true, stopped);
      try {
        const accepted = await tryRunOutOfBand(request, () => {
          if (!request.admit()) throw new Error("Queued agent message was withdrawn");
          message.beforeDispatch?.();
        });
        if (accepted) claim(message, "out_of_band", request);
        else message.outOfBandDeclined = true;
      } catch (error) {
        if (!isQueued(message) || stopped()) continue;
        fail(message, error);
        dependencies.onError(error, request);
      }
    }
  }

  /**
   * Move the queue forward: an interrupt takes it now, a closed window once the turn has ended.
   * `ahead` is what was admitted before this step got in line; it leaves later messages alone.
   */
  async function advance(
    recipientId: string,
    inbox: Inbox,
    ahead: Admitted[],
    stopped: () => boolean,
  ): Promise<void> {
    const interrupts = ahead.filter(isUrgent);
    if (interrupts.length) {
      // A command the provider runs beside the turn replaces nothing, so it takes nothing along.
      await offerOutOfBand(recipientId, interrupts, stopped);
      const last = ahead.findLastIndex(isUrgent);
      if (last >= 0) {
        // An interrupt does not jump the queue: everything admitted before it goes first.
        await deliver(recipientId, ahead.slice(0, last + 1), false, stopped);
        return;
      }
    }
    if (inbox.phase !== "waiting") return;
    const running = (): boolean => inbox.phase === "waiting" && isRunning(recipientId);
    if (running()) await offerOutOfBand(recipientId, ahead, stopped, running);
    // Later mode groups stay queued for the turn ends that follow.
    if (inbox.phase === "waiting" && !isRunning(recipientId))
      await deliver(recipientId, modeGroups(ahead.filter(isQueued))[0] ?? [], true, stopped);
  }

  /**
   * Line up a queue step behind the recipient's current operation, for what is queued now.
   * A Stop voids the steps reserved before it: what they covered waits for the next prompt.
   */
  function lineUp(recipientId: string, inbox: Inbox, onStart?: () => void): void {
    const ahead = [...inbox.messages];
    const stopped = watchForStop(inbox);
    run(recipientId, async () => {
      onStart?.();
      if (!stopped()) await advance(recipientId, inbox, ahead, stopped);
    });
  }

  /** Polling lines up one step at a time; an interrupt always reserves its own place. */
  function nudge(recipientId: string, inbox: Inbox): void {
    if (inbox.advancing) return;
    inbox.advancing = true;
    lineUp(recipientId, inbox, () => {
      inbox.advancing = false;
    });
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
    if (running && nothingToOffer) return;
    nudge(recipientId, inbox);
  }

  function admit(item: Admitted): void {
    const existing = inboxes.get(item.recipientId);
    const inbox = existing ?? {
      messages: [],
      phase: "waiting",
      cancelTimer: () => {},
      cancelCap: () => {},
      advancing: false,
      stops: 0,
    };
    inboxes.set(item.recipientId, inbox);
    inbox.messages.push(item);
    inbox.cancelTimer();
    if (item.urgent) {
      // An interrupt does not wait: it closes the window and takes the queue along. Its place
      // is reserved now, so a prompt admitted after it cannot take it away.
      inbox.cancelCap();
      inbox.phase = "waiting";
      lineUp(item.recipientId, inbox);
      return;
    }
    inbox.cancelTimer = schedule(QUIET_MS, () => attempt(item.recipientId));
    if (inbox.phase === "collecting") return;
    // A new window. It closes after a quiet spell, and no later than the cap.
    inbox.phase = "collecting";
    inbox.cancelCap = schedule(MAX_COLLECTING_MS, () => attempt(item.recipientId));
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

  /**
   * Messages that rode a direct prompt are delivered when the provider admits that prompt.
   * Until it answers, nothing later may pass them.
   */
  async function ride(riders: Admitted[], result: PromptDispatchResult): Promise<void> {
    if (!riders.length) return;
    const { recipientId } = riders[0]!;
    if (result.disposition === "turn_started") {
      try {
        await (dependencies.awaitStart?.(recipientId, result.started) ?? result.started);
      } catch {
        // The provider rejected the prompt that carried them. They go again, in their place.
        handBack(riders);
        return;
      }
    }
    const request = requestFor(recipientId, riders, false, () => false);
    for (const message of riders) claim(message, result.disposition, request);
  }

  /**
   * The stopped recipient stays stopped. Its queue, interrupts included, goes with whatever
   * prompts it next.
   */
  function hold(inbox: Inbox): void {
    inbox.cancelTimer();
    inbox.cancelCap();
    inbox.phase = "held";
    inbox.stops++;
    for (const message of inbox.messages) {
      message.urgent = false;
      message.held = true;
    }
  }

  const unsubscribe = dependencies.subscribe?.((recipientId) => {
    if (inboxes.get(recipientId)?.phase === "waiting" && !isRunning(recipientId))
      attempt(recipientId);
  });
  const unsubscribeStop = dependencies.onStop?.((recipientId) => {
    const inbox = inboxes.get(recipientId);
    if (inbox) hold(inbox);
  });

  return {
    withdrawPending(recipientId, matches) {
      const withdrawn = (inboxes.get(recipientId)?.messages ?? []).filter(
        (message) => isQueued(message) && matches(message.source),
      );
      for (const message of withdrawn) {
        settle(message, "withdrawn");
        message.reject(new DOMException("Agent message withdrawn", "AbortError"));
      }
      // Without the message that reopened it after a Stop, the queue is held again.
      const inbox = inboxes.get(recipientId);
      if (withdrawn.length && inbox?.messages.every((message) => message.held)) hold(inbox);
      return withdrawn.length;
    },
    hasPending(recipientId) {
      const inbox = inboxes.get(recipientId);
      return inbox !== undefined && inbox.phase !== "held";
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
      admit({
        ...message,
        receipt,
        resolve,
        reject,
        state: "queued",
        urgent: message.activeTurnBehavior === "interrupt",
        held: false,
        outOfBandDeclined: false,
      });
      return receipt;
    },
    sendDirect<Result extends PromptDispatchResult>(
      direct: DirectPrompt,
      send: (joined: JoinedPrompt) => Promise<Result>,
    ): Promise<Result> {
      // Its place in line is decided now: what is queued goes with it, what comes later follows.
      const ahead =
        closed || isCommand(direct.prompt)
          ? []
          : [...(inboxes.get(direct.recipientId)?.messages ?? [])];
      return new Promise<Result>((resolve, reject) => {
        run(direct.recipientId, async () => {
          const riders = ahead.filter(isQueued);
          for (const message of riders) message.state = "claimed";
          let result: Result;
          try {
            for (const message of riders) message.beforeDispatch?.();
            result = await send(join(riders, direct));
          } catch (error) {
            handBack(riders);
            reject(error);
            return;
          }
          resolve(result);
          await ride(riders, result);
        });
      });
    },
    async waitForDispatch(recipientId, signal) {
      signal.throwIfAborted();
      const waiting = Array.from(inboxes.get(recipientId)?.messages ?? [], (message) =>
        message.receipt.dispatched.catch((error) => {
          if (message.state !== "withdrawn") throw error;
          return undefined;
        }),
      );
      let unsubscribeCheckpoint: (() => void) | undefined;
      const checkpoint = new Promise<void>((resolve) => {
        const check = () => {
          if (dependencies.hasPendingPermission?.(recipientId) || isHeld(recipientId)) resolve();
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
      const receipts: Promise<unknown>[] = [];
      for (const [recipientId, inbox] of inboxes) {
        inbox.cancelTimer();
        inbox.cancelCap();
        // Shutdown delivers held messages too: nothing in memory survives it.
        inbox.phase = "waiting";
        receipts.push(...inbox.messages.map((message) => message.receipt.dispatched));
        // The drain reads the queue when its turn comes, so it sees what the operation in
        // flight returns to it.
        run(recipientId, async () => {
          for (const group of modeGroups(inbox.messages.filter(isQueued)))
            await deliver(recipientId, group, false, () => false).catch(() => undefined);
        });
      }
      // Each failure is reported and rejects its receipts; shutdown still drains other recipients.
      closing = Promise.allSettled(receipts).then(() => undefined);
      return closing;
    },
  };
}
