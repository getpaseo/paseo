import { useCallback, useEffect, useState } from "react";

/** Cached matches are immediate; the host search still needs the complete candidate set. */
export function useDebouncedSearch(input: { scope: string; query: string; enabled: boolean }) {
  const { scope, query, enabled } = input;
  const [requested, setRequested] = useState({ scope, query: "" });
  const remoteQuery = query && requested.scope === scope ? requested.query : "";
  const needsSearch = enabled && Boolean(query) && remoteQuery !== query;
  useEffect(() => {
    if (!needsSearch) return;
    const timer = setTimeout(() => setRequested({ scope, query }), 400);
    return () => clearTimeout(timer);
  }, [scope, query, needsSearch]);
  const searchNow = useCallback(() => setRequested({ scope, query }), [scope, query]);
  return {
    remoteQuery,
    isWaiting: needsSearch,
    searchNow,
  };
}
