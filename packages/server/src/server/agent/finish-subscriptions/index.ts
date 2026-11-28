import { setTimeout as pause } from "node:timers/promises";
import { HostObservationError } from "../host-operations/index.js";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { FinishObservationResult, FinishRunStarted } from "./internal/observation-buffer.js";
import type { AgentMessageDelivery } from "../agent-messages/index.js";
import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import {
  endsSubscription,
  formatFinishNotificationBody,
  finishNotificationEvents,
  type FinishNotificationReason,
} from "./internal/notification.js";
import {
  createFollowing,
  FOLLOW_LIMIT,
  type FollowOutcome,
  type Notice,
} from "./internal/following.js";
export { createJsonFinishSubscriptionStore } from "./internal/json-store.js";

export interface FinishSubscription {
  id: string;
  callerAgentId: string;
  childAgentId: string;
  serverId?: string;
  /** Creation subscriptions stop reporting after the child is detached. */
  requireParentOwnership?: boolean;
  /**
   * Set once the child ended a turn while it was still working and the caller was told so.
   * The subscription then follows the child until it settles or the follow limit passes.
   */
  followingSince?: string;
  /** Reports every settled run, not just the next one, until the child is archived or removed. */
  standing?: boolean;
  /** Standing only: the caller has the child's latest outcome. */
  reported?: boolean;
}
/**
 * Work that will start the child's next turn without a new prompt from the caller.
 * Recurring triggers such as heartbeats are not pending work: they never settle.
 */
export type PendingWork = "turn" | "background work" | "queued messages" | "delegated agents";
export interface FinishSubscriptionStore {
  list(): Promise<FinishSubscription[]>;
  put(subscription: FinishSubscription): Promise<void>;
  remove(id: string): Promise<void>;
}
export interface FinishObservationSession {
  next(): Promise<FinishObservationResult | FinishRunStarted>;
  close(): Promise<void>;
}
export interface FinishObservation {
  open(subscription: FinishSubscription, signal: AbortSignal): Promise<FinishObservationSession>;
  /** The child's own pending work. Empty when its host cannot tell, as for remote children. */
  pendingWork(subscription: FinishSubscription): readonly PendingWork[];
}
interface Dependencies extends FinishObservation {
  store: FinishSubscriptionStore;
  messages(): AgentMessageDelivery;
  callerIsActive(agentId: string): Promise<boolean>;
  serverId: string;
  logger: Logger;
  retryDelayMs?: number;
  /** How long a child that is still working is followed before the subscription gives up. */
  followLimitMs?: number;
}
export interface FinishRegistration {
  /** The prompt was accepted. Replaces preceding registrations for this pair. */
  accept(): void;
  /** Rejected dispatch preserves preceding registrations. */
  reject(): Promise<void>;
}
export interface FinishSubscriptions {
  start(): Promise<void>;
  /** Pending notification intent, including registration, recovery and unacknowledged delivery. */
  hasPendingForCaller(agentId: string): boolean;
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
  /** A standing watch between runs. Its caller is free to be collected. */
  dormant?: boolean;
  task?: Promise<void>;
  /** Decides a followed child's state again; see `createFollowing`. */
  recheck?(): void;
}
function key(record: FinishSubscription): string {
  return JSON.stringify([record.callerAgentId, record.childAgentId, record.serverId]);
}
const DEFAULT_FOLLOW_LIMIT_MS = 24 * 60 * 60_000;
function coalesce(records: FinishSubscription[]): FinishSubscription {
  return {
    ...records[0]!,
    requireParentOwnership: records.every((intent) => intent.requireParentOwnership === true),
    standing: records.some((intent) => intent.standing === true),
    reported: records.every((intent) => intent.standing === true && intent.reported === true),
  };
}
function childEnded(result: FinishObservationResult): boolean {
  return !result.final || Boolean(result.final.archivedAt);
}

/** Owns durable intent, live observation, supersession, and dispatch acknowledgment. */
export function createFinishSubscriptions(deps: Dependencies): FinishSubscriptions {
  const tasks = new Set<Promise<void>>();
  const watches = new Map<string, Set<Watch>>();
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
  /**
   * A watch that ends without telling its caller leaves that caller's own watchers with no event:
   * the caller may have no work left now.
   */
  function recheckCallerOf(watch: Watch): void {
    const { callerAgentId } = watch.records[0]!;
    for (const group of watches.values())
      for (const watcher of group) {
        const record = watcher.records[0]!;
        if (record.childAgentId === callerAgentId && !record.serverId) watcher.recheck?.();
      }
  }
  async function remove(watch: Watch): Promise<void> {
    // Only IDs captured by this observer are eligible; newer registrations survive.
    for (const record of watch.records) await deps.store.remove(record.id);
  }
  /** An outcome consumes one-shot intent; standing intent stays and records whether it was reported. */
  async function settle(watch: Watch, reported: boolean): Promise<FinishSubscription> {
    const records: FinishSubscription[] = [];
    for (const record of watch.records) {
      // A superseded watch hands its standing records to the replacement; it must not write them.
      watch.controller.signal.throwIfAborted();
      if (record.standing) {
        const next = { ...record, reported };
        // A reported outcome ends the run it followed.
        if (reported) delete next.followingSince;
        await deps.store.put(next);
        records.push(next);
      } else if (reported) await deps.store.remove(record.id);
      else records.push(record);
    }
    watch.records = records;
    return coalesce(records);
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
    notice: Notice,
    permissions: Set<string>,
    signal: AbortSignal,
  ): Promise<void> {
    const { reason, result } = notice;
    const requests = result?.final?.pendingPermissions ?? [];
    for (const id of permissions)
      if (!requests.some((request) => request.id === id)) permissions.delete(id);
    const acknowledgments: Promise<unknown>[] = [];
    for (const request of reason === "needs permission" ? requests : [undefined]) {
      if (signal.aborted) return;
      if (request && permissions.has(request.id)) continue;
      const title = result?.final?.title ?? record.childAgentId;
      const receipt = deps.messages().enqueue({
        recipientId: record.callerAgentId,
        prompt: formatFinishNotificationBody({
          childAgentId: record.childAgentId,
          serverId: record.serverId ?? deps.serverId,
          title,
          reason,
          lastAssistantMessage: result?.lastMessage ?? null,
          permissionRequest: request,
          pendingWork: notice.work,
        }),
        source: {
          kind: "agent-notification",
          agentId: record.childAgentId,
          serverId: record.serverId ?? deps.serverId,
          title,
          event: finishNotificationEvents[reason],
        },
        // A finish report never enters a running turn.
        activeTurnBehavior: "queue",
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
  }
  function delegations(agentId: string): FinishSubscription[] {
    const records: FinishSubscription[] = [];
    for (const group of watches.values())
      for (const watch of group)
        // A standing watch between runs has nothing on the way to its caller.
        if (watch.records[0]!.callerAgentId === agentId && !watch.dormant)
          records.push(watch.records[0]!);
    return records;
  }
  function delegates(agentId: string): boolean {
    return registering.has(agentId) || delegations(agentId).length > 0;
  }
  /**
   * Whether one of the agent's delegations can still bring it a notice. A delegate that has settled
   * is about to report; a delegate that only waits on agents in `chain` never will, so agents that
   * wait on each other settle together.
   */
  function awaitsDelegates(agentId: string, chain: Set<string>): boolean {
    if (registering.has(agentId)) return true;
    chain.add(agentId);
    return delegations(agentId).some((delegation) => {
      // A remote delegate's work is known only to its host.
      if (delegation.serverId) return true;
      const delegate = delegation.childAgentId;
      if (chain.has(delegate)) return false;
      if (deps.pendingWork(delegation).length > 0 || delegations(delegate).length === 0)
        return true;
      return awaitsDelegates(delegate, chain);
    });
  }
  /** Everything that will start the child's next turn by itself. */
  function pendingWork(record: FinishSubscription): PendingWork[] {
    const work = [...deps.pendingWork(record)];
    // A remote child's own subscriptions live on its host.
    if (!record.serverId && awaitsDelegates(record.childAgentId, new Set()))
      work.push("delegated agents");
    return work;
  }
  async function run(watch: Watch, group: Set<Watch>): Promise<void> {
    const signal = watch.controller.signal;
    if (!(await watch.decision) || signal.aborted) return;
    let record = coalesce(watch.records);
    watch.dormant = record.reported;
    let following: ReturnType<typeof createFollowing>;
    /** Follows the watch's current records. A settled run starts the next one unfollowed. */
    function track(): void {
      following = createFollowing({
        records: watch.records,
        store: deps.store,
        limitMs: deps.followLimitMs ?? DEFAULT_FOLLOW_LIMIT_MS,
        pendingWork: () => pendingWork(record),
        reasonFor,
      });
    }
    track();
    watch.recheck = () => following.recheck();
    const permissions = new Set<string>();
    let observation: FinishObservationSession | undefined;
    /** One outcome and how far it got. Retries resume it: nothing is lost or sent twice. */
    let current:
      | { outcome: FollowOutcome; decided: boolean; notice?: Notice; sent: boolean }
      | undefined;
    /** A standing watch saw a run start and has not recorded that its caller is owed the outcome. */
    let waking = false;
    let remoteFailures = 0;
    let retries = 0;
    let warned = false;
    async function observeNext(): Promise<FollowOutcome | FinishRunStarted | undefined> {
      try {
        observation ??= await deps.open(record, signal);
        const result = await following.next(abortable(observation.next(), signal), signal);
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
    async function end(notified: boolean): Promise<true> {
      await remove(watch);
      stop(watch, group);
      if (!notified) recheckCallerOf(watch);
      return true;
    }
    /** Standing intent outlives a reported run unless the child is gone or the follow limit passed. */
    function keepsWatching(notice: Notice): boolean {
      if (!record.standing || notice.reason === "is still working") return false;
      return notice.result !== null && !childEnded(notice.result);
    }
    async function decide(outcome: FollowOutcome): Promise<Notice | undefined | "suppressed"> {
      // A queued follow-up cannot start until the current permission is answered.
      // Its pending registration must not hold the running turn's checkpoint.
      if (outcome === FOLLOW_LIMIT || outcome.status !== "permission" || watch.pending)
        await decisions(group);
      signal.throwIfAborted();
      if (outcome !== FOLLOW_LIMIT && outcome.noRun && record.reported) return "suppressed";
      if (await suppressed(record, outcome === FOLLOW_LIMIT ? undefined : outcome))
        return "suppressed";
      return following.decide(outcome);
    }
    /** Handles one outcome. Returns true once the subscription has ended. */
    async function step(): Promise<boolean> {
      if (await suppressed(record)) return end(false);
      if (!current && !waking) {
        const outcome = await observeNext();
        if (!outcome) {
          await delay(signal, retries++);
          return false;
        }
        if (outcome !== FOLLOW_LIMIT && "runStarted" in outcome) waking = true;
        else current = { outcome, decided: false, sent: false };
      }
      if (!current) {
        watch.dormant = false;
        // The caller no longer has the latest outcome; intent restored after a restart owes it.
        if (record.reported) {
          record = await settle(watch, false);
          track();
        }
        waking = false;
        return false;
      }
      signal.throwIfAborted();
      if (!current.decided) {
        const notice = await decide(current.outcome);
        if (notice === "suppressed") return end(false);
        current = { ...current, decided: true, notice };
      }
      const { notice } = current;
      if (notice && !current.sent) {
        await deliver(record, notice, permissions, signal);
        signal.throwIfAborted();
        current.sent = true;
      }
      // A removal failure retries only the commit, never the already accepted callback.
      if (notice && endsSubscription(notice.reason)) {
        if (!keepsWatching(notice)) return end(true);
        record = await settle(watch, true);
        track();
        watch.dormant = true;
      }
      current = undefined;
      retries = 0;
      warned = false;
      return false;
    }
    try {
      while (!signal.aborted) {
        try {
          if (await step()) return;
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
      return recovering || delegates(agentId);
    },
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
        const group = watches.get(key(record)) ?? new Set<Watch>();
        const predecessors = [...group];
        const watch = attach([record], true);
        const actualGroup = watches.get(key(record))!;
        const registration: FinishRegistration = {
          accept() {
            if (!watch.pending || closed) return;
            watch.pending = false;
            // Standing intent outlives the outcome this registration asked for.
            for (const prior of predecessors)
              for (const intent of prior.records)
                if (intent.standing && !watch.records.some((own) => own.id === intent.id))
                  watch.records.push(intent);
            for (const prior of predecessors) stop(prior, actualGroup);
            watch.decide(true);
            void serialize(async () => {
              for (const prior of predecessors)
                for (const intent of prior.records)
                  if (!intent.standing) await deps.store.remove(intent.id);
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
