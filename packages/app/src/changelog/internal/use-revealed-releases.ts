import { startTransition, useCallback, useEffect, useState } from "react";

/**
 * How much of the changelog is on screen.
 *
 * The latest release renders as soon as there is one, because that is what
 * nearly every open is asking for. The rest of the first page follows
 * immediately, and every Show more after it, as transitions: React then slices
 * that work around the opening animation instead of committing hundreds of list
 * items in one task. The whole document is well over a thousand of them.
 *
 * The input is "releases are on screen", not "the sheet is open". A cold open
 * spends its first moment on the loading state, and stepping the count up
 * during it would land the whole first page in the one commit that follows —
 * the exact commit this exists to split.
 */
const LATEST_RELEASE_ONLY = 1;
const FIRST_PAGE = 5;
const PAGE_SIZE = 10;

export interface RevealedReleases {
  count: number;
  showMore: () => void;
}

export function useRevealedReleases(hasReleases: boolean): RevealedReleases {
  const [count, setCount] = useState(LATEST_RELEASE_ONLY);

  useEffect(() => {
    if (!hasReleases) {
      setCount(LATEST_RELEASE_ONLY);
      return;
    }
    startTransition(() => setCount(FIRST_PAGE));
  }, [hasReleases]);

  const showMore = useCallback(() => {
    startTransition(() => setCount((current) => current + PAGE_SIZE));
  }, []);

  return { count, showMore };
}
