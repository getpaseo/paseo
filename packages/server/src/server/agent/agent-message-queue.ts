import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { AgentManager } from "./agent-manager.js";
import {
  AgentTurnBusyError,
  sendPreparedPromptToAgent,
  type PromptDispatchDisposition,
} from "./agent-prompt.js";
import type { AgentPromptInput } from "./agent-sdk-types.js";
import type { AgentStorage } from "./agent-storage.js";

const PREVIEW_LENGTH = 200;

const QueuedMessageSchema = z.object({
  id: z.string().min(1),
  prompt: z.union([z.string(), z.array(z.object({ type: z.string() }).passthrough())]),
  preview: z.string(),
  sessionMode: z.string().optional(),
  queuedAt: z.string(),
});
const QueueFileSchema = z.object({
  agentId: z.string().min(1),
  messages: z.array(QueuedMessageSchema),
});

export interface QueuedMessage {
  id: string;
  /** Prepared prompt, provenance envelope included, exactly as it will reach the provider. */
  prompt: AgentPromptInput;
  preview: string;
  sessionMode?: string;
  queuedAt: string;
}

export interface QueuedMessageSummary {
  id: string;
  preview: string;
  queuedAt: string;
}

export interface MessageQueueStore {
  list(): Promise<Map<string, QueuedMessage[]>>;
  /** An empty list removes the agent's queue. */
  save(agentId: string, messages: readonly QueuedMessage[]): Promise<void>;
}

/** One atomic JSON file per agent, so a write never touches another agent's queue. */
export function createJsonMessageQueueStore(directory: string): MessageQueueStore {
  const fileFor = (agentId: string) =>
    path.join(directory, `${Buffer.from(agentId).toString("base64url")}.json`);
  return {
    async list() {
      const queues = new Map<string, QueuedMessage[]>();
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return queues;
        throw error;
      }
      for (const name of names) {
        if (!name.endsWith(".json") || name.startsWith(".")) continue;
        const file = QueueFileSchema.parse(
          JSON.parse(await readFile(path.join(directory, name), "utf8")),
        );
        if (file.messages.length) queues.set(file.agentId, file.messages as QueuedMessage[]);
      }
      return queues;
    },
    async save(agentId, messages) {
      if (!messages.length) {
        await rm(fileFor(agentId), { force: true });
        return;
      }
      await writeJsonFileAtomic(fileFor(agentId), { agentId, messages });
    },
  };
}

export type QueueSubmitResult =
  | { disposition: PromptDispatchDisposition }
  | { disposition: "queued"; queuePosition: number };

export interface QueueSubmitInput {
  agentId: string;
  messageId: string;
  prompt: AgentPromptInput;
  /** Text shown while the message waits. */
  text: string;
  sessionMode?: string;
  /** Awaited once, immediately before the message is dispatched or durably queued. */
  beforeAdmission?: () => Promise<void>;
  /** In memory only: called when the message reaches the provider, now or later. */
  onDispatch?: (disposition: PromptDispatchDisposition) => void;
  /** In memory only: called when a queued message is dropped instead of dispatched. */
  onDrop?: (reason: unknown) => void;
}

interface DispatchInput {
  agentId: string;
  messageId: string;
  prompt: AgentPromptInput;
  sessionMode?: string;
  /** A fresh send may revive an archived agent; a queued one never does. */
  unarchive: boolean;
  beforeDispatch?: () => Promise<void>;
}

interface Dependencies {
  store: MessageQueueStore;
  /** Starts a turn only when the agent is idle, else throws {@link AgentTurnBusyError}. */
  dispatch(input: DispatchInput): Promise<PromptDispatchDisposition>;
  /** Includes starting, running, and autonomous turns such as compaction. */
  isRunning(agentId: string): boolean;
  hasPendingPermission(agentId: string): boolean;
  /** Archived and deleted agents drop their queue. */
  isActive(agentId: string): Promise<boolean>;
  /** Called with the agent ID whenever its state may have changed. */
  subscribe(listener: (agentId: string) => void): () => void;
  /** Republish the agent's snapshot after its queue changed. */
  publish(agentId: string): void;
  logger: Logger;
  /** Defer work out of the emitting call stack. */
  defer?: (callback: () => void) => void;
}

export interface AgentMessageQueue {
  /**
   * Load persisted queues and deliver them as their agents become idle. `waitForResume`
   * holds an agent's delivery until restart recovery has sent its resume prompt.
   */
  start(options?: {
    waitForResume?(agentId: string, signal: AbortSignal): Promise<void>;
  }): Promise<void>;
  /**
   * Start a turn now if the agent is idle and nothing is waiting; otherwise hold the
   * message and start it as its own turn after the earlier ones, once the agent is idle.
   */
  submit(input: QueueSubmitInput): Promise<QueueSubmitResult>;
  list(agentId: string): QueuedMessageSummary[];
  hasPending(agentId: string): boolean;
  /** Drop every waiting message for the agent. */
  clear(agentId: string): Promise<void>;
  /** Resolve once nothing waits for this agent, or when it stops at a permission request. */
  waitForDrain(agentId: string, signal: AbortSignal): Promise<void>;
  /** Stop delivering. Waiting messages stay persisted for the next start. */
  close(): Promise<void>;
}

interface Entry extends QueuedMessage {
  onDispatch?: QueueSubmitInput["onDispatch"];
  onDrop?: QueueSubmitInput["onDrop"];
}

export function createAgentMessageQueue(deps: Dependencies): AgentMessageQueue {
  const defer = deps.defer ?? ((callback: () => void) => void setImmediate(callback));
  const queues = new Map<string, Entry[]>();
  const lanes = new Map<string, Promise<unknown>>();
  const drainWaiters = new Map<string, Set<() => void>>();
  const lifetime = new AbortController();
  let loaded: Promise<void> | undefined;
  let closed = false;

  /** Every mutation of one agent's queue runs in order, one at a time. */
  function lane<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = lanes.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    lanes.set(agentId, next);
    void next
      .finally(() => {
        if (lanes.get(agentId) === next) lanes.delete(agentId);
      })
      .catch(() => undefined);
    return next;
  }

  async function replace(agentId: string, messages: Entry[]): Promise<void> {
    await deps.store.save(agentId, messages.map(toStored));
    if (messages.length) queues.set(agentId, messages);
    else queues.delete(agentId);
    deps.publish(agentId);
    settleWaiters(agentId);
  }

  function settleWaiters(agentId: string): void {
    const waiters = drainWaiters.get(agentId);
    if (!waiters) return;
    // A settled waiter removes itself; deleting from a Set while iterating it is safe.
    for (const check of waiters) check();
  }

  function scheduleDrain(agentId: string): void {
    if (closed || !queues.has(agentId) || deps.isRunning(agentId)) return;
    defer(() => {
      void lane(agentId, () => drain(agentId)).catch((error) =>
        deps.logger.error({ err: error, agentId }, "Queued message delivery failed"),
      );
    });
  }

  async function drain(agentId: string): Promise<void> {
    for (;;) {
      const queue = queues.get(agentId);
      if (closed || !queue?.length || deps.isRunning(agentId)) return;
      if (!(await deps.isActive(agentId))) {
        await dropAll(agentId, new Error(`Agent ${agentId} is archived or deleted`));
        return;
      }
      const [head, ...rest] = queue;
      let disposition: PromptDispatchDisposition | null = null;
      try {
        disposition = await deps.dispatch({
          agentId,
          messageId: head!.id,
          prompt: head!.prompt,
          sessionMode: head!.sessionMode,
          unarchive: false,
        });
      } catch (error) {
        // Another send started a turn first; the next idle state resumes delivery.
        if (error instanceof AgentTurnBusyError) return;
        deps.logger.error(
          { err: error, agentId, messageId: head!.id },
          "Dropping a queued message that could not be delivered",
        );
        head!.onDrop?.(error);
      }
      // Removal follows dispatch, so a crash in between delivers the message again.
      await replace(agentId, rest);
      if (disposition) head!.onDispatch?.(disposition);
      if (disposition === "turn_started") return;
    }
  }

  async function dropAll(agentId: string, reason: unknown): Promise<void> {
    const dropped = queues.get(agentId) ?? [];
    await replace(agentId, []);
    for (const entry of dropped) entry.onDrop?.(reason);
  }

  const unsubscribe = deps.subscribe((agentId) => {
    settleWaiters(agentId);
    scheduleDrain(agentId);
  });

  function ensureLoaded(): Promise<void> {
    loaded ??= (async () => {
      for (const [agentId, messages] of await deps.store.list()) {
        if (!queues.has(agentId)) queues.set(agentId, messages);
      }
    })();
    return loaded;
  }

  return {
    async start(options) {
      await ensureLoaded();
      for (const agentId of queues.keys()) {
        void (options?.waitForResume?.(agentId, lifetime.signal) ?? Promise.resolve())
          .then(() => scheduleDrain(agentId))
          .catch(() => undefined);
      }
    },

    async submit(input) {
      if (closed) throw new Error("The message queue is closed");
      await ensureLoaded();
      let admission: Promise<void> | undefined;
      const beforeAdmission = () => (admission ??= input.beforeAdmission?.() ?? Promise.resolve());
      return lane(input.agentId, async (): Promise<QueueSubmitResult> => {
        if (!queues.get(input.agentId)?.length) {
          try {
            const disposition = await deps.dispatch({
              agentId: input.agentId,
              messageId: input.messageId,
              prompt: input.prompt,
              sessionMode: input.sessionMode,
              unarchive: true,
              beforeDispatch: beforeAdmission,
            });
            input.onDispatch?.(disposition);
            return { disposition };
          } catch (error) {
            if (!(error instanceof AgentTurnBusyError)) throw error;
          }
        }
        await beforeAdmission();
        const entry: Entry = {
          id: input.messageId,
          prompt: input.prompt,
          preview: input.text.slice(0, PREVIEW_LENGTH),
          ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
          queuedAt: new Date().toISOString(),
          onDispatch: input.onDispatch,
          onDrop: input.onDrop,
        };
        const messages = [...(queues.get(input.agentId) ?? []), entry];
        await replace(input.agentId, messages);
        scheduleDrain(input.agentId);
        return { disposition: "queued", queuePosition: messages.length };
      });
    },

    list(agentId) {
      return (queues.get(agentId) ?? []).map(({ id, preview, queuedAt }) => ({
        id,
        preview,
        queuedAt,
      }));
    },

    hasPending: (agentId) => queues.has(agentId),

    clear: (agentId) =>
      lane(agentId, () => dropAll(agentId, new Error(`Queue for agent ${agentId} was cleared`))),

    async waitForDrain(agentId, signal) {
      signal.throwIfAborted();
      await ensureLoaded();
      await new Promise<void>((resolve, reject) => {
        const waiters = drainWaiters.get(agentId) ?? new Set<() => void>();
        drainWaiters.set(agentId, waiters);
        const finish = () => {
          waiters.delete(check);
          if (!waiters.size) drainWaiters.delete(agentId);
          signal.removeEventListener("abort", abort);
        };
        const check = () => {
          if (queues.has(agentId) && !deps.hasPendingPermission(agentId)) return;
          finish();
          resolve();
        };
        const abort = () => {
          finish();
          reject(new DOMException("Wait aborted", "AbortError"));
        };
        waiters.add(check);
        signal.addEventListener("abort", abort, { once: true });
        check();
      });
    },

    async close() {
      closed = true;
      lifetime.abort();
      unsubscribe();
      await Promise.allSettled(lanes.values());
    },
  };
}

/** The daemon's queue: messages live in `$PASEO_HOME/agent-message-queue`, one file per agent. */
export function createDaemonAgentMessageQueue(input: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  paseoHome: string;
  logger: Logger;
}): AgentMessageQueue {
  const { agentManager, agentStorage, logger } = input;
  return createAgentMessageQueue({
    store: createJsonMessageQueueStore(path.join(input.paseoHome, "agent-message-queue")),
    dispatch: async (message) =>
      (
        await sendPreparedPromptToAgent({
          agentManager,
          agentStorage,
          agentId: message.agentId,
          prompt: message.prompt,
          sessionMode: message.sessionMode,
          idleOnly: true,
          unarchive: message.unarchive,
          beforeDispatch: message.beforeDispatch,
          runOptions: { clientMessageId: message.messageId },
          logger,
        })
      ).disposition,
    isRunning: (agentId) => agentManager.hasInFlightRun(agentId),
    hasPendingPermission: (agentId) => agentManager.hasPendingPermissions(agentId),
    isActive: async (agentId) => {
      const record = await agentStorage.get(agentId);
      return record ? !record.archivedAt : Boolean(agentManager.getAgent(agentId));
    },
    subscribe: (notify) =>
      agentManager.subscribe(
        (event) => {
          if (event.type === "agent_state") notify(event.agent.id);
          else if (event.type === "agent_removed") notify(event.agentId);
        },
        { replayState: false, includeInternal: true },
      ),
    publish: (agentId) => agentManager.notifyAgentState(agentId),
    logger: logger.child({ module: "agent-message-queue" }),
  });
}

function toStored(entry: Entry): QueuedMessage {
  return {
    id: entry.id,
    prompt: entry.prompt,
    preview: entry.preview,
    ...(entry.sessionMode ? { sessionMode: entry.sessionMode } : {}),
    queuedAt: entry.queuedAt,
  };
}
