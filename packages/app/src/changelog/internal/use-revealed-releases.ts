import { startTransition, useCallback, useEffect, useState } from "react";

/**
 * How much of the changelog is on screen.
 *
 * The latest release renders with the sheet, because that is what nearly every
 * open is asking for. The rest of the first page follows immediately, and every
 * Show more after it, as transitions: React then slices that work around the
 * opening animation instead of committing hundreds of list items in one task.
 * The whole document is well over a thousand of them.
 */
const LATEST_RELEASE_ONLY = 1;
const FIRST_PAGE = 5;
const PAGE_SIZE = 10;

export interface RevealedReleases {
  count: number;
  showMore: () => void;
}

export function useRevealedReleases(visible: boolean): RevealedReleases {
  const [count, setCount] = useState(LATEST_RELEASE_ONLY);

  useEffect(() => {
    if (!visible) {
      setCount(LATEST_RELEASE_ONLY);
      return;
    }
    startTransition(() => setCount(FIRST_PAGE));
  }, [visible]);

  const showMore = useCallback(() => {
    startTransition(() => setCount((current) => current + PAGE_SIZE));
  }, []);

  return { count, showMore };
}
