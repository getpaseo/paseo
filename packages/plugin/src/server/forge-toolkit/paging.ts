/**
 * Page-number pagination guards. Forge APIs that page with `page` + `per_page`
 * can loop forever when the host ignores the page cursor or reports a moving
 * total, so every walk needs both a repeat detector and a continuation cap.
 */
export interface ForgePageGuard {
  /**
   * Records a full page. Throws when the forge returns a page it already
   * returned, which means the cursor stopped advancing.
   */
  assertProgress(input: { itemCount: number; pageKeys: readonly string[] }): void;
  /**
   * Returns whether another page should be requested. Throws once an unbounded
   * walk passes the continuation cap.
   */
  hasNextPage(input: {
    itemCount: number;
    page: number;
    visited: number;
    total: number | undefined;
  }): boolean;
}

export interface CreateForgePageGuardOptions {
  /** Brand shown in the thrown message, e.g. "Gitee". */
  brand: string;
  pageSize: number;
  /** Continuation cap used when the forge does not report a total. */
  maxContinuationsWithoutTotal?: number;
}

const DEFAULT_MAX_CONTINUATIONS_WITHOUT_TOTAL = 100;

export function createForgePageGuard(options: CreateForgePageGuardOptions): ForgePageGuard {
  const maxContinuations =
    options.maxContinuationsWithoutTotal ?? DEFAULT_MAX_CONTINUATIONS_WITHOUT_TOTAL;
  const seenFullPageFingerprints = new Set<string>();
  return {
    assertProgress(input) {
      if (input.itemCount < options.pageSize) return;
      const fingerprint = JSON.stringify(input.pageKeys);
      if (seenFullPageFingerprints.has(fingerprint)) {
        throw new Error(`${options.brand} pagination repeated a full page without making progress`);
      }
      seenFullPageFingerprints.add(fingerprint);
    },
    hasNextPage(input) {
      if (input.itemCount < options.pageSize) return false;
      if (input.total !== undefined) return input.visited < input.total;
      if (input.page > maxContinuations) {
        throw new Error(
          `${options.brand} pagination exceeded ${maxContinuations} continuations without total`,
        );
      }
      return true;
    },
  };
}
