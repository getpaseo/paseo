import { LRUCache } from "lru-cache";
import type { CheckoutDiffCompare, CheckoutDiffResult } from "../utils/checkout-git.js";

interface ActiveRead {
  promise: Promise<CheckoutDiffResult>;
  invalidated: boolean;
}

/** Completed payloads are bounded; active work survives invalidation and eviction. */
export class CheckoutDiffCache {
  private readonly values = new LRUCache<
    string,
    { value: CheckoutDiffResult; loadedAt: number; lastReadStarted: number }
  >({
    max: 64,
  });
  private readonly active = new Map<string, ActiveRead>();

  constructor(private readonly now: () => number) {}

  read(
    cwd: string,
    compare: CheckoutDiffCompare,
    options: { force?: boolean; reason?: string } | undefined,
    load: () => Promise<CheckoutDiffResult>,
  ): Promise<CheckoutDiffResult> {
    if (options?.force && !options.reason)
      throw new Error("WorkspaceGitService forced read requires a reason");
    const key = JSON.stringify([
      cwd,
      compare.mode,
      compare.mode === "base" ? (compare.baseRef ?? null) : null,
      compare.ignoreWhitespace === true,
      compare.includeStructured === true,
    ]);
    const cached = this.values.get(key);
    const now = this.now();
    if (
      !options?.force &&
      cached &&
      (now - cached.loadedAt <= 15_000 || now - cached.lastReadStarted < 2_000)
    )
      return Promise.resolve(cached.value);
    const pending = this.active.get(key);
    if (pending) {
      if (!pending.invalidated) return pending.promise;
      // A caller arriving after a change needs a fresh read, once the old one
      // finishes. The original caller can still receive its snapshot promptly.
      const reload = () => this.read(cwd, compare, options, load);
      return pending.promise.then(reload, reload);
    }
    if (cached) cached.lastReadStarted = now;

    // Defer load until ownership is installed, including synchronous invalidations.
    const read: ActiveRead = {
      invalidated: false,
      promise: Promise.resolve()
        .then(load)
        .then((value) => {
          // Never repopulate the cache with a snapshot invalidated during its build.
          if (!read.invalidated)
            this.values.set(key, { value, loadedAt: this.now(), lastReadStarted: now });
          return value;
        })
        .finally(() => this.active.delete(key)),
    };
    this.active.set(key, read);
    return read.promise;
  }

  invalidate(cwd: string, mode: CheckoutDiffCompare["mode"]): void {
    for (const key of new Set([...this.values.keys(), ...this.active.keys()])) {
      const [cachedCwd, cachedMode] = JSON.parse(key) as string[];
      if (cachedCwd !== cwd || cachedMode !== mode) continue;
      this.values.delete(key);
      const pending = this.active.get(key);
      if (pending) pending.invalidated = true;
    }
  }
}
