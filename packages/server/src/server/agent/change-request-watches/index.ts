import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FORGE_IDS } from "@getpaseo/protocol/forge-manifest";
import type { Logger } from "pino";
import { z } from "zod";
import type { ChangeRequestRouter } from "../../../services/change-request-router.js";
import {
  changeRequestStatusSchema,
  type ChangeRequestSnapshot,
} from "../../../services/change-request-source.js";
import type { AgentMessageDelivery } from "../agent-messages/index.js";
import type {
  DaemonBackgroundWorkInput,
  DaemonBackgroundWorkKey,
} from "../background-work/index.js";
import { writeJsonFileAtomic } from "../../atomic-file.js";

const DIGEST_WINDOW_MS = 30_000;
const LEGACY_DEFAULT_FORGE = "github";
const LEGACY_INFERENCE_FORGES = ["github", "gitlab"] as const;
const persistedWatchGroupSchema = z.object({
  forge: z.string().min(1).optional(),
  url: z.url(),
  snapshot: changeRequestStatusSchema,
  seenActivity: z.array(z.string()),
  watchers: z.array(z.object({ agentId: z.string(), startedAt: z.string().optional() })),
});
type PersistedWatchGroup = z.infer<typeof persistedWatchGroupSchema>;
type WatchGroup = Omit<PersistedWatchGroup, "forge"> & { forge: string };
type Watcher = WatchGroup["watchers"][number];
interface DigestWindow {
  dueAt: number;
  timer: NodeJS.Timeout;
  recipients: Map<string, string[]>;
}

interface Observation {
  stale: boolean;
  ready: Promise<ChangeRequestSnapshot>;
  release(): void;
}
interface Dependencies {
  router: ChangeRequestRouter;
  paseoHome: string;
  logger: Logger;
  isActive(agentId: string): Promise<boolean>;
  messages(): AgentMessageDelivery;
  backgroundWork: {
    setDaemonBackgroundWork(input: DaemonBackgroundWorkInput): void;
    removeDaemonBackgroundWork(key: DaemonBackgroundWorkKey): void;
  };
}

function backgroundWorkKey(agentId: string, url: string): DaemonBackgroundWorkKey {
  return { agentId, namespace: "change-request-watch", id: url };
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
    .map(
      (check) =>
        `Check failed on ${next.headSha}: ${JSON.stringify(check.name)}${check.url ? ` (${check.url})` : ""}`,
    );
  if (
    next.checksState === "passed" &&
    (previous.checksState !== "passed" || previous.headSha !== next.headSha)
  ) {
    changes.push(`Checks passed on ${next.headSha}.`);
  }
  for (const activity of next.activity) {
    if (seen.has(activity.id)) continue;
    changes.push(activity.message ?? `New ${activity.kind}: ${activity.url}`);
    seen.add(activity.id);
  }
  if (next.state !== "open") changes.push(`Change request ${next.state}.`);
  return { changes, seenActivity: [...seen] };
}

export type ChangeRequestWatches = ReturnType<typeof createChangeRequestWatches>;

export function createChangeRequestWatches(deps: Dependencies) {
  const file = join(deps.paseoHome, "change-request-watches.json");
  const groups = new Map<string, WatchGroup>();
  const unrestored: WatchGroup[] = [];
  const observations = new Map<string, Observation>();
  const registrations = new Map<string, number>();
  let mutations = Promise.resolve();
  const windows = new Map<string, DigestWindow>();
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

  function handOff(url: string, window: DigestWindow): void {
    if (windows.get(url) !== window) return;
    windows.delete(url);
    clearTimeout(window.timer);
    for (const [recipientId, events] of window.recipients) {
      deps.messages().enqueue({
        recipientId,
        source: { kind: "change-request-update", url },
        prompt: [`Paseo change request update for ${url}`, ...events].join("\n"),
        unarchive: false,
      });
    }
  }

  function recordChanges(
    url: string,
    watchers: WatchGroup["watchers"],
    changes: string[],
    observedAt: number,
  ): void {
    let window = windows.get(url);
    if (window && observedAt >= window.dueAt) {
      handOff(url, window);
      window = undefined;
    }
    if (!window) {
      const dueAt = observedAt + DIGEST_WINDOW_MS;
      const recipients = new Map<string, string[]>();
      const timer = setTimeout(
        () => {
          void serialize(async () => {
            handOff(url, pending);
          }).catch((err) =>
            deps.logger.warn({ err, url }, "Could not enqueue change request updates"),
          );
        },
        Math.max(0, dueAt - Date.now()),
      );
      timer.unref();
      const pending: DigestWindow = { dueAt, recipients, timer };
      windows.set(url, pending);
      window = pending;
    }
    for (const { agentId } of watchers) {
      const events = window.recipients.get(agentId);
      if (events) events.push(...changes);
      else window.recipients.set(agentId, [...changes]);
    }
  }

  function withdraw(agentId: string, matches: (url: string) => boolean): string | undefined {
    let withdrawn: string | undefined;
    for (const [url, window] of windows) {
      if (!window.recipients.has(agentId) || !matches(url)) continue;
      window.recipients.delete(agentId);
      withdrawn ??= url;
      if (!window.recipients.size) {
        clearTimeout(window.timer);
        windows.delete(url);
      }
    }
    deps.messages().withdrawPending(agentId, (source) => {
      if (source.kind !== "change-request-update" || !matches(source.url)) return false;
      withdrawn ??= source.url;
      return true;
    });
    return withdrawn;
  }

  function withdrawByInput(agentId: string, input: string): string | undefined {
    const trimmed = input.trim();
    const candidates = new Set([trimmed]);
    for (const forge of FORGE_IDS) {
      const source = deps.router.source(forge);
      if (!source) continue;
      try {
        candidates.add(source.resolve(trimmed));
      } catch {
        // This source does not recognize the URL.
      }
    }
    return withdraw(agentId, (url) => candidates.has(url));
  }

  async function commit(...updates: WatchGroup[]): Promise<void> {
    const next = new Map(groups);
    for (const group of updates) next.set(group.url, group);
    await writeJsonFileAtomic(file, [
      ...[...next.values()].filter(({ watchers }) => watchers.length),
      ...unrestored,
    ]);
    for (const group of updates) {
      const previous = groups.get(group.url);
      // An in-flight subscription still needs the committed baseline and its observation.
      if (group.watchers.length || registrations.has(group.url)) {
        groups.set(group.url, group);
      } else {
        groups.delete(group.url);
        stopObserving(group.url);
      }
      syncBackgroundWork(group, previous?.watchers);
    }
  }

  function describeWatch(forge: string, url: string): string {
    const source = deps.router.source(forge);
    if (!source) return url;
    try {
      return source.describe(url);
    } catch {
      return url;
    }
  }

  function syncBackgroundWork(
    { forge, url, watchers }: WatchGroup,
    previous: Watcher[] = [],
  ): void {
    if (previous === watchers) return;
    const current = new Set(watchers);
    for (const watcher of previous) {
      if (!current.has(watcher)) {
        deps.backgroundWork.removeDaemonBackgroundWork(backgroundWorkKey(watcher.agentId, url));
      }
    }
    const existing = new Set(previous);
    for (const watcher of watchers) {
      if (existing.has(watcher)) continue;
      deps.backgroundWork.setDaemonBackgroundWork({
        ...backgroundWorkKey(watcher.agentId, url),
        kind: "monitor",
        description: describeWatch(forge, url),
        startedAt: watcher.startedAt ?? new Date().toISOString(),
        stop: async () => {
          await unsubscribe(watcher.agentId, url, watcher);
        },
      });
    }
  }

  function observe(forge: string, url: string): Observation {
    const existing = observations.get(url);
    if (existing) return existing;
    const source = deps.router.source(forge);
    if (!source) {
      throw new Error(`Change request watches are not supported for ${forge}.`);
    }
    let resolve!: (snapshot: ChangeRequestSnapshot) => void;
    let reject!: (error: unknown) => void;
    const ready = new Promise<ChangeRequestSnapshot>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    void ready.catch(() => undefined);
    const release = source.observe(url, {
      knownActivity: () => new Set(groups.get(url)?.seenActivity),
      snapshot: (snapshot) =>
        serialize(async () => {
          if (closed || observations.get(url) !== observation) return;
          const group = groups.get(url);
          if (!group) {
            observation.stale = false;
            resolve(snapshot);
            return;
          }
          const { changes, seenActivity } = describeUpdate(group, snapshot);
          const { activity: _activity, ...status } = snapshot;
          if (!changes.length) {
            if (JSON.stringify(status) !== JSON.stringify(group.snapshot)) {
              await commit({ ...group, snapshot: status });
            }
            observation.stale = false;
            resolve(snapshot);
            return;
          }
          const observedAt = Date.now();
          await commit({
            ...group,
            snapshot: status,
            seenActivity,
            watchers: status.state === "open" ? group.watchers : [],
          });
          if (!closed) recordChanges(url, group.watchers, changes, observedAt);
          observation.stale = false;
          resolve(snapshot);
          if (snapshot.state !== "open") stopObserving(url);
        }).catch((error) => {
          reject(error);
          throw error;
        }),
      error(error) {
        if (!observation.stale) {
          deps.logger.warn({ err: error, url, forge }, "Change request observation became stale");
        }
        observation.stale = true;
        if (!groups.has(url)) {
          reject(error);
          stopObserving(url);
        }
        deps.logger.debug({ err: error, url, forge }, "Change request observation failed");
      },
    });
    const observation: Observation = {
      stale: true,
      ready,
      release() {
        reject(new Error("Change request observation ended"));
        release();
      },
    };
    observations.set(url, observation);
    return observation;
  }

  function matchActiveGroup(input: string): { forge: string; url: string } | null {
    const trimmed = input.trim();
    const direct = groups.get(trimmed);
    if (direct) return { forge: direct.forge, url: direct.url };
    const sourcesTried = new Set<string>();
    for (const group of groups.values()) {
      if (sourcesTried.has(group.forge)) continue;
      sourcesTried.add(group.forge);
      const source = deps.router.source(group.forge);
      if (!source) continue;
      try {
        const canonical = source.resolve(trimmed);
        const matched = groups.get(canonical);
        if (matched && matched.forge === group.forge) {
          return { forge: matched.forge, url: matched.url };
        }
      } catch {
        // Input did not belong to this forge.
      }
    }
    return null;
  }

  function subscribe(agentId: string, input: string) {
    if (closed) return Promise.reject(new Error("Change request watches are closed"));
    if (recoveryError) {
      return Promise.reject(
        new Error("Change request watches could not recover.", { cause: recoveryError }),
      );
    }
    const active = matchActiveGroup(input);
    if (active) {
      return subscribeResolved(agentId, active.forge, active.url);
    }
    return deps.router
      .resolve(input)
      .then(({ forge, url }) => subscribeResolved(agentId, forge, url));
  }

  function subscribeResolved(agentId: string, forge: string, url: string) {
    registrations.set(url, (registrations.get(url) ?? 0) + 1);
    const existing = groups.get(url);
    const finish = () => {
      const remaining = registrations.get(url)! - 1;
      if (remaining) {
        registrations.set(url, remaining);
      } else {
        registrations.delete(url);
        if (!groups.get(url)?.watchers.length) {
          groups.delete(url);
          stopObserving(url);
        }
      }
    };
    const commitSubscription = (initial: ChangeRequestSnapshot) =>
      serialize(async () => {
        if (closed || !(await deps.isActive(agentId))) throw new Error("Agent is no longer active");
        const group = groups.get(url);
        const { activity, ...initialStatus } = initial;
        const snapshot = group?.snapshot ?? initialStatus;
        const subscribed = snapshot.state === "open";
        if (subscribed && !group?.watchers.some((watcher) => watcher.agentId === agentId)) {
          await commit({
            forge: group?.forge ?? forge,
            url,
            snapshot,
            seenActivity: group?.seenActivity ?? activity.map(({ id }) => id),
            watchers: [
              ...(group?.watchers ?? []),
              { agentId, startedAt: new Date().toISOString() },
            ],
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
          stale: observations.get(url)?.stale ?? Boolean(existing),
        };
      });
    const pending = existing
      ? commitSubscription({ ...existing.snapshot, activity: [] })
      : observe(forge, url).ready.then(commitSubscription);
    return pending.finally(finish);
  }

  function removeWatcher(group: WatchGroup, agentId: string): Promise<void> {
    return commit({
      ...group,
      watchers: group.watchers.filter((watcher) => watcher.agentId !== agentId),
    });
  }

  function unsubscribe(agentId: string, url: string, expected?: Watcher) {
    return serialize(async () => {
      const group = groups.get(url);
      const watcher = group?.watchers.find((entry) => entry.agentId === agentId);
      // Stop can wait behind an unsubscribe and a new subscription for the same PR.
      if (expected && watcher !== expected) {
        throw new Error("Background work is no longer available to stop");
      }
      if (group && watcher) await removeWatcher(group, agentId);
      const withdrawn = withdraw(agentId, (address) => address === url);
      return { url, removed: Boolean(watcher || withdrawn) };
    });
  }

  function archive(agentId: string): Promise<void> {
    return serialize(async () => {
      if (closed) return;
      withdraw(agentId, () => true);
      const updates: WatchGroup[] = [];
      for (const group of groups.values()) {
        const watchers = group.watchers.filter((watcher) => watcher.agentId !== agentId);
        if (watchers.length !== group.watchers.length) updates.push({ ...group, watchers });
      }
      if (updates.length) await commit(...updates);
    });
  }

  function inferLegacyForge(url: string): string {
    for (const candidate of LEGACY_INFERENCE_FORGES) {
      const source = deps.router.source(candidate);
      if (!source) continue;
      try {
        source.resolve(url);
        return candidate;
      } catch {
        // URL does not match this forge's canonical path shape.
      }
    }
    return LEGACY_DEFAULT_FORGE;
  }

  return {
    async start() {
      const active: WatchGroup[] = [];
      let pruned = false;
      try {
        const stored = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "[]";
          throw error;
        });
        const restored = z.array(persistedWatchGroupSchema).parse(JSON.parse(stored));
        for (const record of restored) {
          const group: WatchGroup = {
            ...record,
            forge: record.forge ?? inferLegacyForge(record.url),
          };
          if (group.snapshot.state !== "open") {
            pruned = true;
            continue;
          }
          const watchers = [];
          for (const watcher of group.watchers) {
            if (await deps.isActive(watcher.agentId)) watchers.push(watcher);
          }
          pruned ||= watchers.length !== group.watchers.length;
          if (!watchers.length) continue;
          const nextGroup = { ...group, watchers };
          if (!deps.router.source(nextGroup.forge)) {
            deps.logger.warn(
              { forge: nextGroup.forge, url: nextGroup.url },
              "Skipping persisted change request watch for unsupported forge",
            );
            unrestored.push(nextGroup);
            continue;
          }
          active.push(nextGroup);
        }
      } catch (error) {
        recoveryError = error;
        deps.logger.error({ err: error, file }, "Could not recover change request watches");
        return;
      }
      if (pruned) {
        try {
          await writeJsonFileAtomic(file, [...active, ...unrestored]);
        } catch (error) {
          deps.logger.warn({ err: error, file }, "Could not prune archived change request watches");
        }
      }
      for (const group of active) {
        groups.set(group.url, group);
        syncBackgroundWork(group);
        try {
          observe(group.forge, group.url);
        } catch (error) {
          deps.logger.warn(
            { err: error, forge: group.forge, url: group.url },
            "Could not start observing restored change request watch",
          );
        }
      }
    },
    subscribe,
    async unsubscribe(agentId: string, input: string) {
      const active = matchActiveGroup(input);
      if (active) return unsubscribe(agentId, active.url);
      const withdrawn = await serialize(async () => withdrawByInput(agentId, input));
      if (withdrawn) return { url: withdrawn, removed: true };
      const { url } = await deps.router.resolve(input);
      return unsubscribe(agentId, url);
    },
    archive,
    async close() {
      closed = true;
      for (const window of windows.values()) clearTimeout(window.timer);
      windows.clear();
      for (const url of observations.keys()) stopObserving(url);
      await mutations;
    },
  };
}
