import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import {
  changeRequestStatusSchema,
  type ChangeRequestSnapshot,
  type ChangeRequestSource,
} from "../../../services/change-request-source.js";
import { writeJsonFileAtomic } from "../../atomic-file.js";

const DIGEST_WINDOW_MS = 30_000;
const DELIVERY_RETRY_MS = 5_000;
const digestSchema = z.object({
  id: z.string(),
  dueAt: z.number(),
  events: z.array(z.string()),
});
const watchGroupSchema = z.object({
  url: z.string(),
  snapshot: changeRequestStatusSchema,
  windowEnd: z.number(),
  seenActivity: z.array(z.string()),
  watchers: z.array(z.object({ agentId: z.string(), digests: z.array(digestSchema) })),
});
type WatchGroup = z.infer<typeof watchGroupSchema>;

interface Observation {
  ready: Promise<ChangeRequestSnapshot>;
  release(): void;
}
interface Dependencies {
  source: ChangeRequestSource;
  paseoHome: string;
  logger: Logger;
  isActive(agentId: string): Promise<boolean>;
  /** Return false when the recipient is still in its current turn. */
  deliver(
    agentId: string,
    digest: {
      id: string;
      text: string;
      signal: AbortSignal;
      isPending(): boolean;
    },
  ): Promise<boolean>;
}

function describeUpdate(group: WatchGroup, next: ChangeRequestSnapshot) {
  const previous = group.snapshot;
  const failed = new Set(
    previous.checks.filter((check) => check.state === "failed").map((check) => check.id),
  );
  const seen = new Set(group.seenActivity);
  const changes = next.checks
    .filter(
      (check) =>
        check.state === "failed" && (next.headSha !== previous.headSha || !failed.has(check.id)),
    )
    .map((check) => `Check failed on ${next.headSha}: ${JSON.stringify(check.name)}`);
  if (
    next.checksState === "passed" &&
    (previous.checksState !== "passed" || previous.headSha !== next.headSha)
  ) {
    changes.push(`Checks passed on ${next.headSha}.`);
  }
  for (const activity of next.activity) {
    if (seen.has(activity.id)) continue;
    changes.push(`New ${activity.kind}: ${activity.url}`);
    seen.add(activity.id);
  }
  if (next.state !== "open") changes.push(`Change request ${next.state}.`);
  return { changes, seenActivity: [...seen] };
}

export type ChangeRequestWatches = ReturnType<typeof createChangeRequestWatches>;

export function createChangeRequestWatches(deps: Dependencies) {
  const file = join(deps.paseoHome, "change-request-watches.json");
  const groups = new Map<string, WatchGroup>();
  const observations = new Map<string, Observation>();
  const registrations = new Map<string, number>();
  let mutations = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const shutdown = new AbortController();
  const activeDeliveries = new Map<string, Promise<void>>();
  const nextDeliveryByAgent = new Map<string, number>();
  const retries = new Map<string, number>();
  const accepted = new Set<string>();
  let closed = false;
  let recoveryError: unknown;

  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = mutations.then(action);
    mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function stopObserving(url: string): void {
    observations.get(url)?.release();
    observations.delete(url);
  }

  function armDelivery(): void {
    clearTimeout(timer);
    if (closed) return;
    nextDeliveryByAgent.clear();
    for (const group of groups.values()) {
      for (const watcher of group.watchers) {
        const digest = watcher.digests[0];
        if (!digest || activeDeliveries.has(watcher.agentId)) continue;
        const dueAt = Math.max(digest.dueAt, retries.get(watcher.agentId) ?? 0);
        const earliest = nextDeliveryByAgent.get(watcher.agentId) ?? Infinity;
        nextDeliveryByAgent.set(watcher.agentId, Math.min(dueAt, earliest));
      }
    }
    let next = Infinity;
    for (const dueAt of nextDeliveryByAgent.values()) next = Math.min(dueAt, next);
    if (Number.isFinite(next)) {
      timer = setTimeout(() => void flush(), Math.max(0, next - Date.now()));
      timer.unref();
    }
  }

  async function commit(group: WatchGroup): Promise<void> {
    const next = new Map(groups);
    if (group.watchers.length) next.set(group.url, group);
    else next.delete(group.url);
    await writeJsonFileAtomic(file, [...next.values()]);
    if (group.watchers.length) groups.set(group.url, group);
    else groups.delete(group.url);
    if (!group.watchers.length) stopObserving(group.url);
  }

  function observe(url: string): Observation {
    const existing = observations.get(url);
    if (existing) return existing;
    let resolve!: (snapshot: ChangeRequestSnapshot) => void;
    let reject!: (error: unknown) => void;
    const ready = new Promise<ChangeRequestSnapshot>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    void ready.catch(() => undefined);
    const release = deps.source.observe(url, {
      knownActivity: () => new Set(groups.get(url)?.seenActivity),
      snapshot: (snapshot) =>
        serialize(async () => {
          if (closed || observations.get(url) !== observation) return;
          const group = groups.get(url);
          if (!group) {
            resolve(snapshot);
            return;
          }
          const { changes, seenActivity } = describeUpdate(group, snapshot);
          const { activity: _activity, ...status } = snapshot;
          if (!changes.length) {
            if (JSON.stringify(status) !== JSON.stringify(group.snapshot)) {
              await commit({ ...group, snapshot: status });
            }
            resolve(snapshot);
            return;
          }
          const now = Date.now();
          const windowEnd = now >= group.windowEnd ? now + DIGEST_WINDOW_MS : group.windowEnd;
          const next: WatchGroup = {
            ...group,
            snapshot: status,
            windowEnd,
            seenActivity,
            watchers: group.watchers.map((watcher) => {
              const last = watcher.digests.at(-1);
              const digest =
                last?.dueAt === windowEnd
                  ? { ...last, events: [...last.events, ...changes] }
                  : { id: randomUUID(), dueAt: windowEnd, events: changes };
              return {
                ...watcher,
                digests: [
                  ...(last?.dueAt === windowEnd ? watcher.digests.slice(0, -1) : watcher.digests),
                  digest,
                ],
              };
            }),
          };
          await commit(next);
          resolve(snapshot);
          if (snapshot.state !== "open") stopObserving(url);
          armDelivery();
        }).catch((error) => {
          reject(error);
          throw error;
        }),
      error(error) {
        if (!groups.has(url)) {
          reject(error);
          stopObserving(url);
        }
        deps.logger.debug({ err: error, url }, "Change request observation failed");
      },
    });
    const observation: Observation = {
      ready,
      release() {
        reject(new Error("Change request observation ended"));
        release();
      },
    };
    observations.set(url, observation);
    return observation;
  }

  async function subscribe(agentId: string, input: string) {
    if (closed) throw new Error("Change request watches are closed");
    const url = deps.source.resolve(input);
    if (recoveryError)
      throw new Error("Change request watches could not recover.", { cause: recoveryError });
    registrations.set(url, (registrations.get(url) ?? 0) + 1);
    try {
      const existing = groups.get(url);
      const initial =
        existing && existing.snapshot.state !== "open"
          ? { ...existing.snapshot, activity: [] }
          : await observe(url).ready;
      return await serialize(async () => {
        if (closed || !(await deps.isActive(agentId))) throw new Error("Agent is no longer active");
        const group = groups.get(url);
        const { activity, ...initialStatus } = initial;
        const snapshot = group?.snapshot ?? initialStatus;
        const subscribed = snapshot.state === "open";
        if (subscribed && !group?.watchers.some((watcher) => watcher.agentId === agentId)) {
          await commit({
            url,
            snapshot,
            windowEnd: group?.windowEnd ?? 0,
            seenActivity: group?.seenActivity ?? activity.map(({ id }) => id),
            watchers: [...(group?.watchers ?? []), { agentId, digests: [] }],
          });
        }
        return {
          url,
          state: snapshot.state,
          headSha: snapshot.headSha,
          checksState: snapshot.checksState,
          checks: snapshot.checks,
          reviewDecision: snapshot.reviewDecision,
          subscribed,
        };
      });
    } finally {
      const remaining = registrations.get(url)! - 1;
      if (remaining) {
        registrations.set(url, remaining);
      } else {
        registrations.delete(url);
        if (!groups.has(url)) stopObserving(url);
      }
    }
  }

  function removeWatcher(group: WatchGroup, agentId: string): Promise<void> {
    return commit({
      ...group,
      watchers: group.watchers.filter((watcher) => watcher.agentId !== agentId),
    });
  }

  function pendingDigest(url: string, agentId: string) {
    return groups.get(url)?.watchers.find((watcher) => watcher.agentId === agentId)?.digests[0];
  }

  function dispatch(
    url: string,
    agentId: string,
    digest: z.infer<typeof digestSchema>,
  ): Promise<void> {
    const isPending = () => !closed && pendingDigest(url, agentId)?.id === digest.id;
    return (async () => {
      if (!(await deps.isActive(agentId))) {
        await serialize(async () => {
          if (isPending()) await removeWatcher(groups.get(url)!, agentId);
        });
        return;
      }
      if (!isPending()) return;
      const delivered =
        accepted.has(digest.id) ||
        (await deps.deliver(agentId, {
          id: digest.id,
          text: [`Paseo change request update for ${url}`, ...digest.events].join("\n"),
          signal: shutdown.signal,
          isPending,
        }));
      if (!delivered) {
        retries.set(agentId, Date.now() + DELIVERY_RETRY_MS);
        return;
      }
      accepted.add(digest.id);
      await serialize(async () => {
        const group = groups.get(url);
        const watcher = group?.watchers.find((entry) => entry.agentId === agentId);
        if (!group || !watcher || watcher.digests[0]?.id !== digest.id) return;
        const remaining = watcher.digests.slice(1);
        if (group.snapshot.state !== "open" && !remaining.length) {
          await removeWatcher(group, agentId);
        } else {
          const watchers = group.watchers.slice();
          watchers[watchers.indexOf(watcher)] = { agentId, digests: remaining };
          await commit({ ...group, watchers });
        }
      });
      accepted.delete(digest.id);
    })()
      .catch((err) => {
        if (closed) return;
        retries.set(agentId, Date.now() + DELIVERY_RETRY_MS);
        deps.logger.warn({ err, url, agentId }, "Could not deliver change request updates");
      })
      .finally(() => {
        activeDeliveries.delete(agentId);
        armDelivery();
      });
  }

  function flush(): Promise<void> {
    if (closed) return Promise.resolve();
    const now = Date.now();
    for (const [url, group] of groups) {
      for (const watcher of group.watchers) {
        const { agentId } = watcher;
        const digest = watcher.digests[0];
        if (!digest || digest.dueAt > now || activeDeliveries.has(agentId)) continue;
        if ((retries.get(agentId) ?? 0) > now) continue;
        retries.delete(agentId);
        const task = dispatch(url, agentId, digest);
        activeDeliveries.set(agentId, task);
      }
    }
    armDelivery();
    return Promise.all(activeDeliveries.values()).then(() => undefined);
  }

  return {
    async start() {
      let restored: WatchGroup[];
      try {
        const stored = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "[]";
          throw error;
        });
        restored = z.array(watchGroupSchema).parse(JSON.parse(stored));
      } catch (error) {
        recoveryError = error;
        deps.logger.error({ err: error, file }, "Could not recover change request watches");
        return;
      }
      for (const group of restored) groups.set(group.url, group);
      for (const group of restored) {
        const watchers = [];
        for (const watcher of group.watchers) {
          if (await deps.isActive(watcher.agentId)) watchers.push(watcher);
        }
        if (watchers.length !== group.watchers.length) await commit({ ...group, watchers });
      }
      for (const group of groups.values()) {
        if (group.snapshot.state === "open") observe(group.url);
      }
      armDelivery();
    },
    subscribe,
    unsubscribe(agentId: string, input: string) {
      return serialize(async () => {
        const url = deps.source.resolve(input);
        const group = groups.get(url);
        const removed = group?.watchers.some((watcher) => watcher.agentId === agentId) ?? false;
        if (group && removed) await removeWatcher(group, agentId);
        armDelivery();
        return { url, removed };
      });
    },
    archive(agentId: string) {
      return serialize(async () => {
        for (const group of groups.values()) {
          if (group.watchers.some((watcher) => watcher.agentId === agentId)) {
            await removeWatcher(group, agentId);
          }
        }
        armDelivery();
      });
    },
    flush,
    agentIdle(agentId: string) {
      if (!nextDeliveryByAgent.has(agentId)) return;
      retries.delete(agentId);
      void flush();
    },
    async close() {
      closed = true;
      shutdown.abort();
      clearTimeout(timer);
      for (const url of observations.keys()) stopObserving(url);
      await Promise.all(activeDeliveries.values());
      await mutations;
    },
  };
}
