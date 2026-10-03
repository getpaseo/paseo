import { useCallback, useEffect, useState } from "react";

/** Keep the last remote query while edits can be answered by local filtering. */
export function useEmptySearch(input: {
  scope: string;
  query: string;
  hasMatches: boolean;
  enabled: boolean;
}) {
  const { scope, query, hasMatches, enabled } = input;
  const [requested, setRequested] = useState({ scope, query: "" });
  const remoteQuery = query && requested.scope === scope ? requested.query : "";
  const needsSearch = enabled && Boolean(query) && !hasMatches && remoteQuery !== query;
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
