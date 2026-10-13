import { LRUCache } from "lru-cache";
import type { CheckoutDiffCompare, CheckoutDiffResult } from "../utils/checkout-git.js";

interface ActiveRead {
  promise: Promise<CheckoutDiffResult>;
  invalidated: boolean;
}

interface CachedDiff {
  value: CheckoutDiffResult;
  loadedAt: number;
  lastReadStarted: number;
}

interface CheckoutDiffReadInput {
  cwd: string;
  compare: CheckoutDiffCompare;
  force?: boolean;
  reason?: string;
  load: () => Promise<CheckoutDiffResult>;
}

/** Completed payloads are bounded; active work survives invalidation and eviction. */
export class CheckoutDiffCache {
  private readonly values = new LRUCache<string, CachedDiff>({
    max: 64,
  });
  private readonly active = new Map<string, ActiveRead>();

  constructor(private readonly now: () => number) {}

  read(input: CheckoutDiffReadInput): Promise<CheckoutDiffResult> {
    const { cwd, compare, force, reason, load } = input;
    if (force && !reason) throw new Error("WorkspaceGitService forced read requires a reason");
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
      !force &&
      cached &&
      (now - cached.loadedAt <= 15_000 || now - cached.lastReadStarted < 2_000)
    )
      return Promise.resolve(cached.value);
    const pending = this.active.get(key);
    if (pending) {
      if (force) {
        pending.invalidated = true;
        this.values.delete(key);
      }
      if (!pending.invalidated) return pending.promise;
      // A caller arriving after a change needs a fresh read, once the old one
      // finishes. The original caller can still receive its snapshot promptly.
      // The older result cannot enter the cache. Drop force when retrying so
      // callers waiting on that same result share the next fresh build.
      const reload = () => this.read({ ...input, force: false });
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
