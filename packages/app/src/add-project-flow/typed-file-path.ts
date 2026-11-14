import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useFetchQuery } from "@/data/query";

// A path pasted from a terminal or editor often names a file. Directory search offers that
// file's directory instead, so Enter opens the project that contains it.
export interface TypedFilePath {
  /** The directory the typed path sits in, as typed: `/`, `/tmp/x`, `~/src`. */
  parent: string;
  /** The final segment of the typed path. */
  name: string;
}

export type TypedFileClient = Pick<DaemonClient, "getDirectorySuggestions">;

const LOOKUP_STALE_TIME_MS = 15_000;

// The rooted forms the daemon resolves: absolute POSIX paths and `~/`. The daemon reads `\` in a
// query as a separator, so a name containing one would be looked up as a different path.
export function locateTypedPath(query: string): TypedFilePath | null {
  const typed = query.trim().replace(/\/{2,}/g, "/");
  if (!typed.startsWith("/") && !typed.startsWith("~/")) return null;
  if (typed.endsWith("/")) return null;
  const slash = typed.lastIndexOf("/");
  const name = typed.slice(slash + 1);
  if (!name || name === "." || name === ".." || name.includes("\\")) return null;
  return { parent: slash === 0 ? "/" : typed.slice(0, slash), name };
}

// An exact lookup reads only the named entry, through the daemon's directory-search filesystem
// limit, and a miss costs no walk. It follows symlinks, so only a path that resolves to a regular
// file counts. A failed lookup rejects rather than answering "not a file".
export async function findTypedFilePath(input: {
  query: string;
  client: TypedFileClient;
}): Promise<TypedFilePath | null> {
  const location = locateTypedPath(input.query);
  if (!location) return null;
  const payload = await input.client.getDirectorySuggestions({
    cwd: location.parent,
    query: location.name,
    includeFiles: true,
    includeDirectories: false,
    matchMode: "exact",
    limit: 1,
  });
  if (payload.error) throw new Error(payload.error);
  return payload.entries.some((entry) => entry.kind === "file") ? location : null;
}

interface TypedFileLookup {
  query: string;
  file: TypedFilePath | null;
}

export function useTypedFilePath(input: {
  client: TypedFileClient | null;
  hostId: string | null;
  query: string;
  enabled: boolean;
}): {
  file: TypedFilePath | null;
  isFetching: boolean;
  /** The typed file for `query`, waiting for a lookup in flight or starting one. */
  resolve: (query: string) => Promise<TypedFilePath | null>;
} {
  const { client, hostId, query, enabled } = input;
  const queryClient = useQueryClient();
  const lookupOptions = useCallback(
    (lookupQuery: string) => ({
      queryKey: ["add-project-flow-typed-path", hostId, lookupQuery],
      queryFn: async (): Promise<TypedFileLookup> => {
        if (!client) throw new Error("Host is unavailable");
        return {
          query: lookupQuery,
          file: await findTypedFilePath({ query: lookupQuery, client }),
        };
      },
    }),
    [client, hostId],
  );
  const lookup = useFetchQuery({
    ...lookupOptions(query),
    enabled: Boolean(client && enabled && locateTypedPath(query)),
    dataShape: "value",
    retry: false,
    staleTimeMs: LOOKUP_STALE_TIME_MS,
  });
  const resolve = useCallback(
    async (lookupQuery: string) => {
      if (!client || !enabled || !locateTypedPath(lookupQuery)) return null;
      const result = await queryClient.fetchQuery({
        ...lookupOptions(lookupQuery),
        retry: false,
        staleTime: LOOKUP_STALE_TIME_MS,
      });
      return result.file;
    },
    [client, enabled, lookupOptions, queryClient],
  );
  // A disabled lookup can still hold data cached on another page; it answers nothing.
  const file = enabled && lookup.data?.query === query ? lookup.data.file : null;
  return { file, isFetching: enabled && lookup.isFetching, resolve };
}
