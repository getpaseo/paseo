import type { Logger } from "pino";
import { withTimeout } from "../../../utils/promise-timeout.js";

/** A captured runtime capability. Its lifecycle owner revalidates before releasing it. */
export interface RuntimeCleanupCandidate {
  readonly identity: object;
  readonly agentId: string;
  readonly parentAgentId: string | undefined;
  readonly provider: string;
  readonly sessionId: string | null;
  readonly lastActivityAt: number;
  isEligible(): boolean;
  canStopRuntime?(): Promise<boolean>;
  closeIfEligible(revalidate: () => boolean): Promise<boolean>;
}
interface Options {
  enabled: boolean;
  runtimes(): readonly RuntimeCleanupCandidate[];
  isProtected?(agentId: string): boolean;
  logger: Pick<Logger, "debug" | "info" | "warn">;
  now?: () => number;
  schedule?: (tick: () => void, intervalMs: number) => () => void;
}
interface CollectionEntry {
  agentId: string;
  provider: string;
  sessionId: string;
}
interface CollectionResult {
  collected: CollectionEntry[];
  failures: Array<{ agentId: string; error: unknown }>;
}
const IDLE_PERIOD_MS = 60 * 60_000;

/** Owns idle clocks, baseline eligibility, optional provider vetoes and the sweep lifetime. */
export function createIdleRuntimeCleanup(options: Options) {
  const protectedAt = new WeakMap<object, { at: number; protected: boolean }>();
  let collection: Promise<CollectionResult> | null = null;
  let stopped = false;
  let enabled = options.enabled;
  let generation = 0;
  const isProtected = options.isProtected ?? (() => false);
  const now = options.now ?? Date.now;

  function familyOf(root: RuntimeCleanupCandidate, runtimes: readonly RuntimeCleanupCandidate[]) {
    const family = new Map([[root.agentId, root]]);
    for (const parent of family.values()) {
      for (const child of runtimes) {
        if (child.parentAgentId === parent.agentId) family.set(child.agentId, child);
      }
    }
    return [...family.values()];
  }
  function baselineAllows(family: readonly RuntimeCleanupCandidate[]) {
    return family.every((runtime) => runtime.isEligible() && !isProtected(runtime.agentId));
  }
  async function providersAllow(
    family: readonly RuntimeCleanupCandidate[],
    isCurrent: () => boolean,
  ) {
    for (const runtime of family) {
      if (!isCurrent()) return false;
      if (!runtime.canStopRuntime) continue;
      const allowed = await withTimeout(
        runtime.canStopRuntime(),
        10_000,
        `Runtime safety probe timed out for ${runtime.agentId}`,
      );
      if (allowed !== true) return false;
    }
    return true;
  }
  async function collect(): Promise<CollectionResult> {
    const result: CollectionResult = { collected: [], failures: [] };
    const sweepGeneration = generation;
    const isCurrent = () => enabled && !stopped && generation === sweepGeneration;
    if (!isCurrent()) return result;
    const timestamp = now();
    const runtimes = options.runtimes();
    for (const runtime of runtimes) {
      if (!isCurrent()) break;
      if (!runtime.sessionId) continue;
      const family = familyOf(runtime, runtimes);
      try {
        const allowed = baselineAllows(family) && (await providersAllow(family, isCurrent));
        if (!isCurrent()) break;
        if (!allowed) {
          protectedAt.set(runtime.identity, { at: timestamp, protected: true });
          options.logger.debug(
            { agentId: runtime.agentId },
            "Idle runtime retained by a baseline or provider veto",
          );
          continue;
        }
        const previous = protectedAt.get(runtime.identity);
        if (previous?.protected)
          protectedAt.set(runtime.identity, { at: timestamp, protected: false });
        const idleSince = Math.max(
          runtime.lastActivityAt,
          protectedAt.get(runtime.identity)?.at ?? 0,
        );
        if (timestamp - idleSince < IDLE_PERIOD_MS) continue;
        const revalidate = () => {
          const currentFamily = familyOf(runtime, options.runtimes());
          return (
            isCurrent() &&
            currentFamily.length === family.length &&
            currentFamily.every((current) =>
              family.some((captured) => captured.identity === current.identity),
            ) &&
            baselineAllows(family)
          );
        };
        if (await runtime.closeIfEligible(revalidate)) {
          const entry = {
            agentId: runtime.agentId,
            provider: runtime.provider,
            sessionId: runtime.sessionId,
          };
          result.collected.push(entry);
          options.logger.info(entry, "Collected idle agent runtime");
        } else if (isCurrent()) {
          protectedAt.set(runtime.identity, { at: timestamp, protected: true });
        }
      } catch (error) {
        if (!isCurrent()) break;
        protectedAt.set(runtime.identity, { at: timestamp, protected: true });
        result.failures.push({ agentId: runtime.agentId, error });
        options.logger.warn(
          { agentId: runtime.agentId, err: error },
          "Idle runtime cleanup failed",
        );
      }
    }
    return result;
  }
  function sweep(): Promise<CollectionResult> {
    if (collection) return collection;
    collection = collect().finally(() => {
      collection = null;
    });
    return collection;
  }
  const schedule =
    options.schedule ??
    ((tick, intervalMs) => {
      const timer = setInterval(tick, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    });
  const cancel = schedule(() => {
    void sweep().catch((error) => options.logger.warn({ err: error }, "Idle runtime sweep failed"));
  }, 60_000);
  return {
    sweep,
    setEnabled(value: boolean) {
      if (enabled === value) return;
      enabled = value;
      generation++;
    },
    async close() {
      stopped = true;
      cancel();
      await collection;
    },
  };
}
