import { authServerRequest } from "../../utils/auth-server.js";
import type {
  LibraryEntry,
  LibraryKind,
  LibraryPayload,
  LibraryScope,
  LibrarySource,
  LibrarySyncTarget,
  LibraryVisibility,
} from "./types.js";

export async function listEntries(args: {
  kind?: LibraryKind;
  scope?: LibraryScope;
  scopeId?: string;
}): Promise<LibraryEntry[]> {
  const qs = new URLSearchParams();
  if (args.kind) qs.set("kind", args.kind);
  if (args.scope) qs.set("scope", args.scope);
  if (args.scopeId) qs.set("scopeId", args.scopeId);
  const res = await authServerRequest<{ entries: LibraryEntry[] }>({
    path: `/api/library${qs.toString() ? `?${qs}` : ""}`,
  });
  return res.entries;
}

export async function createEntry(input: {
  kind: LibraryKind;
  name: string;
  displayName?: string;
  description?: string | null;
  payload: LibraryPayload;
  iconUrl?: string | null;
  source?: LibrarySource;
  catalogId?: string | null;
  scope: LibraryScope;
  scopeId?: string | null;
  visibility?: LibraryVisibility;
  syncTargets?: LibrarySyncTarget[];
}): Promise<LibraryEntry> {
  const res = await authServerRequest<{ entry: LibraryEntry }>({
    method: "POST",
    path: "/api/library",
    body: input,
  });
  return res.entry;
}

export async function deleteEntry(entryId: string): Promise<void> {
  await authServerRequest<void>({
    method: "DELETE",
    path: `/api/library/${encodeURIComponent(entryId)}`,
  });
}
