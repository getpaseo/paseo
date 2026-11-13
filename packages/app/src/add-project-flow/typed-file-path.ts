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

interface ListedDirectory {
  entries: readonly { name: string; kind: string }[];
}

export type ListDirectory = (cwd: string, path: string) => Promise<ListedDirectory>;

const LISTING_STALE_TIME_MS = 15_000;

// The rooted forms the daemon's home search resolves: absolute POSIX paths and `~/`.
export function locateTypedPath(query: string): TypedFilePath | null {
  const typed = query.trim().replace(/\/{2,}/g, "/");
  if (!typed.startsWith("/") && !typed.startsWith("~/")) return null;
  if (typed.endsWith("/")) return null;
  const slash = typed.lastIndexOf("/");
  const name = typed.slice(slash + 1);
  if (!name || name === "." || name === "..") return null;
  return { parent: slash === 0 ? "/" : typed.slice(0, slash), name };
}

// Directory suggestions cannot answer this cheaply: a typed path that names nothing falls through
// to a walk of its parent's subtree, and outside the home directory the home search answers
// nothing at all. Listing the parent is one directory read wherever the path is. The listing
// reports a symlink as a file whatever it points to, so a match is confirmed by listing the typed
// path itself, which succeeds only for a directory.
export async function findTypedFilePath(input: {
  query: string;
  listDirectory: ListDirectory;
}): Promise<TypedFilePath | null> {
  const location = locateTypedPath(input.query);
  if (!location) return null;
  const parent = await input.listDirectory(location.parent, ".").catch(() => null);
  const listed = parent?.entries.some(
    (entry) => entry.name === location.name && entry.kind !== "directory",
  );
  if (!listed) return null;
  const isDirectory = await input.listDirectory(location.parent, location.name).then(
    () => true,
    () => false,
  );
  return isDirectory ? null : location;
}

export function useTypedFilePath(input: {
  client: Pick<DaemonClient, "listDirectory"> | null;
  hostId: string | null;
  query: string;
  enabled: boolean;
}): { file: TypedFilePath | null; isFetching: boolean } {
  const { client, hostId, query, enabled } = input;
  const queryClient = useQueryClient();
  // Typing the final segment re-runs the lookup on every pause; the parent listing is shared.
  const listDirectory = useCallback<ListDirectory>(
    async (cwd, path) => {
      if (!client) throw new Error("Host is unavailable");
      return queryClient.fetchQuery({
        queryKey: ["add-project-flow-typed-path-listing", hostId, cwd, path],
        queryFn: () => client.listDirectory(cwd, path),
        staleTime: LISTING_STALE_TIME_MS,
        retry: false,
      });
    },
    [client, hostId, queryClient],
  );
  const lookup = useFetchQuery({
    queryKey: ["add-project-flow-typed-path", hostId, query],
    queryFn: async () => ({ query, file: await findTypedFilePath({ query, listDirectory }) }),
    enabled: Boolean(client && enabled && locateTypedPath(query)),
    dataShape: "value",
    retry: false,
    staleTimeMs: LISTING_STALE_TIME_MS,
  });
  return {
    file: lookup.data?.query === query ? lookup.data.file : null,
    isFetching: lookup.isFetching,
  };
}
