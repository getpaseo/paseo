import { setTimeout as pause } from "node:timers/promises";
import { HostObservationError } from "../host-operations/index.js";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { FinishObservationResult } from "./internal/observation-buffer.js";
import type { AgentMessageDelivery } from "../agent-messages/index.js";
import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import {
  formatFinishNotificationBody,
  finishNotificationEvents,
  type FinishNotificationReason,
} from "./internal/notification.js";
export { createJsonFinishSubscriptionStore } from "./internal/json-store.js";

export interface FinishSubscription {
  id: string;
  callerAgentId: string;
  childAgentId: string;
  serverId?: string;
  /** Creation subscriptions stop reporting after the child is detached. */
  requireParentOwnership?: boolean;
}
export interface FinishSubscriptionStore {
  list(): Promise<FinishSubscription[]>;
  put(subscription: FinishSubscription): Promise<void>;
  remove(id: string): Promise<void>;
}
export interface FinishObservationSession {
  next(): Promise<FinishObservationResult>;
  close(): Promise<void>;
}
export interface FinishObservation {
  open(subscription: FinishSubscription, signal: AbortSignal): Promise<FinishObservationSession>;
}
interface Dependencies extends FinishObservation {
  store: FinishSubscriptionStore;
  messages(): AgentMessageDelivery;
  callerIsActive(agentId: string): Promise<boolean>;
  serverId: string;
  logger: Logger;
  retryDelayMs?: number;
}
export interface FinishRegistration {
  /** The prompt was accepted. Replaces preceding registrations for this pair. */
  accept(): void;
  /** Rejected dispatch preserves preceding registrations. */
  reject(): Promise<void>;
}
/** What a `wait_for_agent` call already handed to the caller. */
export type WaitDeliveredOutcome = { kind: "terminal" } | { kind: "permission"; requestId: string };
export interface FinishNotificationHold {
  /** Ends the hold. A delivered outcome suppresses the matching notification. */
  settle(delivered: WaitDeliveredOutcome | null): void;
}
export interface FinishSubscriptions {
  start(): Promise<void>;
  /** Pending notification intent, including registration, recovery and unacknowledged delivery. */
  hasPendingForCaller(agentId: string): boolean;
  /**
   * Held while a local caller blocks in wait_for_agent on its child. Notifications for
   * the pair wait for open holds, then drop an outcome the wait already returned.
   */
  hold(input: { callerAgentId: string; childAgentId: string }): FinishNotificationHold;
  register(
    input: Omit<FinishSubscription, "id">,
    pendingDispatch?: boolean,
  ): Promise<FinishRegistration>;
  close(): Promise<void>;
}
interface Watch {
  records: FinishSubscription[];
  controller: AbortController;
  decision: Promise<boolean>;
  decide(accepted: boolean): void;
  pending: boolean;
  task?: Promise<void>;
}
interface WaitState {
  holds: Set<Promise<void>>;
  deliveredTerminal: boolean;
  deliveredPermissionIds: Set<string>;
}
function key(record: FinishSubscription): string {
  return JSON.stringify([record.callerAgentId, record.childAgentId, record.serverId]);
}
function waitKey(callerAgentId: string, childAgentId: string): string {
  return JSON.stringify([callerAgentId, childAgentId]);
}

/** Owns durable intent, live observation, supersession, and dispatch acknowledgment. */
export function createFinishSubscriptions(deps: Dependencies): FinishSubscriptions {
  const tasks = new Set<Promise<void>>();
  const watches = new Map<string, Set<Watch>>();
  // wait_for_agent is local, so only local subscriptions consult these.
  const waits = new Map<string, WaitState>();
  let closed = false;
  let recovering = true;
  const registering = new Map<string, number>();
  let mutations = Promise.resolve();
  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = mutations.then(action);
    mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  function releaseWaitIfUnused(waitId: string): void {
    const state = waits.get(waitId);
    if (
      state &&
      !state.holds.size &&
      !state.deliveredTerminal &&
      !state.deliveredPermissionIds.size
    )
      waits.delete(waitId);
  }
  function hold(input: { callerAgentId: string; childAgentId: string }): FinishNotificationHold {
    const waitId = waitKey(input.callerAgentId, input.childAgentId);
    const state = waits.get(waitId) ?? {
      holds: new Set<Promise<void>>(),
      deliveredTerminal: false,
      deliveredPermissionIds: new Set<string>(),
    };
    waits.set(waitId, state);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.holds.add(held);
    let settled = false;
    return {
      settle(delivered) {
        if (settled) return;
        settled = true;
        if (delivered?.kind === "terminal") state.deliveredTerminal = true;
        else if (delivered?.kind === "permission")
          state.deliveredPermissionIds.add(delivered.requestId);
        state.holds.delete(held);
        release();
        releaseWaitIfUnused(waitId);
      },
    };
  }
  /**
   * Waits for open wait_for_agent holds, then consumes what they delivered. Returns true
   * when the wait already returned this terminal outcome; marks delivered permission
   * requests as notified.
   */
  async function deliveredByWait(
    record: FinishSubscription,
    result: FinishObservationResult,
    permissions: Set<string>,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (record.serverId) return false;
    const waitId = waitKey(record.callerAgentId, record.childAgentId);
    const state = waits.get(waitId);
    if (!state) return false;
    await abortable(Promise.all(state.holds), signal);
    let delivered = false;
    if (reasonFor(result) === "needs permission") {
      for (const request of result.final?.pendingPermissions ?? [])
        if (state.deliveredPermissionIds.delete(request.id)) permissions.add(request.id);
    } else if (state.deliveredTerminal) {
      state.deliveredTerminal = false;
      delivered = true;
    }
    releaseWaitIfUnused(waitId);
    return delivered;
  }
  function attach(records: FinishSubscription[], pending: boolean): Watch {
    let decide!: Watch["decide"];
    const decision = new Promise<boolean>((resolve) => {
      decide = resolve;
    });
    const watch: Watch = { records, controller: new AbortController(), pending, decision, decide };
    const group = watches.get(key(records[0]!)) ?? new Set<Watch>();
    group.add(watch);
    watches.set(key(records[0]!), group);
    if (!pending) decide(true);
    watch.task = run(watch, group).catch((error) =>
      deps.logger.error({ err: error }, "Finish subscription failed"),
    );
    tasks.add(watch.task);
    void watch.task.then(() => tasks.delete(watch.task!));
    return watch;
  }
  function stop(watch: Watch, group: Set<Watch>): void {
    watch.controller.abort();
    watch.decide(false);
    group.delete(watch);
    if (!group.size && watches.get(key(watch.records[0]!)) === group)
      watches.delete(key(watch.records[0]!));
  }
  async function remove(watch: Watch): Promise<void> {
    // Only IDs captured by this observer are eligible; newer registrations survive.
    for (const record of watch.records) await deps.store.remove(record.id);
  }
  async function delay(signal: AbortSignal, attempt: number): Promise<void> {
    try {
      await pause(
        Math.min((deps.retryDelayMs ?? 1000) * 2 ** Math.min(attempt, 3), 5000),
        undefined,
        { signal },
      );
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
  async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    let abort!: () => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([operation, cancellation]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  async function decisions(group: Set<Watch>): Promise<void> {
    // New candidates may arrive while an older dispatch decision is pending.
    while (true) {
      if (closed) return;
      const pending = [...group].filter((watch) => watch.pending);
      if (!pending.length) return;
      await Promise.all(pending.map((watch) => watch.decision));
    }
  }
  async function suppressed(
    record: FinishSubscription,
    result?: WaitForFinishResult,
  ): Promise<boolean> {
    if (!(await deps.callerIsActive(record.callerAgentId))) return true;
    if (!record.requireParentOwnership || !result?.final) return false;
    const parent = getParentAddressFromLabels(
      result.final.labels,
      record.serverId ?? deps.serverId,
    );
    return parent?.agentId !== record.callerAgentId || parent.serverId !== deps.serverId;
  }
  function reasonFor(result: FinishObservationResult): FinishNotificationReason {
    if (result.reason === "host unreachable" || result.reason === "host removed")
      return result.reason;
    if (!result.final) return "is unavailable";
    if (result.final.status === "closed") return "was closed";
    if (result.status === "error") return "errored";
    if (result.status === "permission") return "needs permission";
    return result.reason ?? "finished";
  }
  async function deliver(
    record: FinishSubscription,
    result: FinishObservationResult,
    permissions: Set<string>,
    signal: AbortSignal,
  ): Promise<boolean> {
    const requests = result.final?.pendingPermissions ?? [];
    const reason = reasonFor(result);
    for (const id of permissions)
      if (!requests.some((request) => request.id === id)) permissions.delete(id);
    const acknowledgments: Promise<unknown>[] = [];
    for (const request of reason === "needs permission" ? requests : [undefined]) {
      if (signal.aborted) return false;
      if (request && permissions.has(request.id)) continue;
      const title = result.final?.title ?? record.childAgentId;
      const receipt = deps.messages().enqueue({
        recipientId: record.callerAgentId,
        prompt: formatFinishNotificationBody({
          childAgentId: record.childAgentId,
          serverId: record.serverId ?? deps.serverId,
          title,
          reason,
          lastAssistantMessage: result.lastMessage,
          permissionRequest: request,
        }),
        source: {
          kind: "agent-notification",
          agentId: record.childAgentId,
          serverId: record.serverId ?? deps.serverId,
          title,
          event: finishNotificationEvents[reason],
        },
        activeTurnBehavior: "steer",
        unarchive: false,
      });
      acknowledgments.push(
        receipt.dispatched.then(() => {
          if (request) permissions.add(request.id);
          return undefined;
        }),
      );
    }
    await abortable(Promise.all(acknowledgments), signal);
    if (signal.aborted) return false;
    if (reason !== "needs permission") return true;
    return false;
  }
  async function run(watch: Watch, group: Set<Watch>): Promise<void> {
    const signal = watch.controller.signal;
    if (!(await watch.decision) || signal.aborted) return;
    const record = {
      ...watch.records[0]!,
      requireParentOwnership: watch.records.every(
        (intent) => intent.requireParentOwnership === true,
      ),
    };
    const permissions = new Set<string>();
    let observation: FinishObservationSession | undefined;
    let pending: FinishObservationResult | undefined;
    let acknowledged = false;
    let remoteFailures = 0;
    let retries = 0;
    let warned = false;
    async function observeNext(): Promise<FinishObservationResult | undefined> {
      try {
        observation ??= await deps.open(record, signal);
        const result = await abortable(observation.next(), signal);
        remoteFailures = 0;
        return result;
      } catch (error) {
        await observation?.close();
        observation = undefined;
        signal.throwIfAborted();
        if (!(error instanceof HostObservationError) || !record.serverId) throw error;
        if (error.reason === "connecting") return undefined;
        if (error.reason === "unreachable" && ++remoteFailures < 3) return undefined;
        // Host visibility ends this subscription; it says nothing about child completion.
        return {
          status: "error",
          final: null,
          lastMessage: null,
          error: null,
          reason: error.reason === "removed" ? "host removed" : "host unreachable",
        };
      }
    }
    try {
      while (!signal.aborted) {
        try {
          if (await suppressed(record)) {
            await remove(watch);
            stop(watch, group);
            return;
          }
          if (!pending) pending = await observeNext();
          if (!pending) {
            await delay(signal, retries++);
            continue;
          }
          if (signal.aborted) return;
          await decisions(group);
          if (signal.aborted) return;
          if (await suppressed(record, pending)) {
            await remove(watch);
            stop(watch, group);
            return;
          }
          if (!acknowledged)
            acknowledged = await deliveredByWait(record, pending, permissions, signal);
          if (!acknowledged) acknowledged = await deliver(record, pending, permissions, signal);
          if (acknowledged) {
            // A removal failure retries only the commit, never the already accepted callback.
            await remove(watch);
            stop(watch, group);
            return;
          }
          pending = undefined;
          retries = 0;
          warned = false;
        } catch (error) {
          if (signal.aborted) return;
          // Delivery and storage failures retain the captured outcome and durable intent.
          // They do not spend the remote-observation budget or change the child's outcome.
          if (!warned) {
            deps.logger.warn(
              { err: error, subscription: record.id },
              "Retrying finish subscription",
            );
            warned = true;
          }
          await delay(signal, retries++);
        }
      }
    } finally {
      await observation?.close();
    }
  }

  return {
    hasPendingForCaller(agentId) {
      if (recovering || registering.has(agentId)) return true;
      for (const group of watches.values()) {
        for (const watch of group) if (watch.records[0]!.callerAgentId === agentId) return true;
      }
      return false;
    },
    hold,
    start: () =>
      serialize(async () => {
        const groups = new Map<string, FinishSubscription[]>();
        for (const record of await deps.store.list()) {
          const records = groups.get(key(record)) ?? [];
          records.push(record);
          groups.set(key(record), records);
        }
        for (const records of groups.values()) attach(records, false);
        recovering = false;
      }),
    register: (input, pendingDispatch = false) => {
      registering.set(input.callerAgentId, (registering.get(input.callerAgentId) ?? 0) + 1);
      return serialize(async () => {
        if (closed) throw new Error("Finish subscriptions are closed");
        const record: FinishSubscription = {
          ...input,
          serverId: input.serverId === deps.serverId ? undefined : input.serverId,
          id: randomUUID(),
        };
        await deps.store.put(record);
        if (!record.serverId) {
          // This subscription watches new work, so an earlier wait's result is not its outcome.
          const state = waits.get(waitKey(record.callerAgentId, record.childAgentId));
          if (state) {
            state.deliveredTerminal = false;
            releaseWaitIfUnused(waitKey(record.callerAgentId, record.childAgentId));
          }
        }
        const group = watches.get(key(record)) ?? new Set<Watch>();
        const predecessors = [...group];
        const watch = attach([record], true);
        const actualGroup = watches.get(key(record))!;
        const registration: FinishRegistration = {
          accept() {
            if (!watch.pending || closed) return;
            watch.pending = false;
            for (const prior of predecessors) stop(prior, actualGroup);
            watch.decide(true);
            void serialize(async () => {
              for (const prior of predecessors) await remove(prior);
            }).catch((error) =>
              deps.logger.error({ err: error }, "Failed to remove superseded finish subscriptions"),
            );
          },
          reject: () =>
            serialize(async () => {
              await remove(watch);
              stop(watch, actualGroup);
            }),
        };
        if (!pendingDispatch) registration.accept();
        return registration;
      }).finally(() => {
        const remaining = registering.get(input.callerAgentId)! - 1;
        if (remaining) registering.set(input.callerAgentId, remaining);
        else registering.delete(input.callerAgentId);
      });
    },
    async close() {
      closed = true;
      await mutations;
      for (const group of watches.values())
        for (const watch of group) {
          watch.controller.abort();
          watch.decide(false);
        }
      await mutations;
      await Promise.all(tasks);
      await deps.store.list();
      // Dispatch may still be pending. The delivery owner drains it after observers stop.
    },
  };
}

export { createFinishObservation } from "./internal/observation.js";
