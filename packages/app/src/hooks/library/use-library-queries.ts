import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createLibraryEntry,
  deleteLibraryEntry,
  listLibraryEntries,
  setLibraryActivation,
  updateLibraryEntry,
  type LibraryEntry,
  type LibraryKind,
  type LibraryPayload,
  type LibraryScope,
  type LibrarySyncTarget,
  type LibraryVisibility,
} from "@/api/library";
import { fetchMcpCatalog, fetchSkillsCatalog, type CatalogPage } from "@/api/catalog";
import { useUpgradeModal } from "@/components/billing/upgrade-modal-provider";

const MINUTE = 60_000;

export const libraryKeys = {
  all: ["library"] as const,
  list: (kind: LibraryKind | undefined, scope?: LibraryScope, scopeId?: string) =>
    ["library", "list", kind ?? "all", scope ?? "any", scopeId ?? "any"] as const,
  catalog: (kind: "mcp" | "skills", query: string) => ["library", "catalog", kind, query] as const,
};

export function useLibraryEntries(
  sessionToken: string | null,
  kind: LibraryKind | undefined,
  scope?: LibraryScope,
  scopeId?: string,
) {
  return useQuery<LibraryEntry[]>({
    queryKey: libraryKeys.list(kind, scope, scopeId),
    enabled: sessionToken !== null,
    staleTime: MINUTE,
    queryFn: () => listLibraryEntries({ sessionToken, kind, scope, scopeId }),
  });
}

export function useMcpCatalog(sessionToken: string | null, query: string) {
  return useQuery<CatalogPage>({
    queryKey: libraryKeys.catalog("mcp", query),
    enabled: sessionToken !== null,
    staleTime: 10 * MINUTE,
    // Keep last good data on screen when the catalog endpoint blips — the UI
    // surfaces an "offline" banner instead of a blank error state.
    placeholderData: (prev) => prev,
    queryFn: () => fetchMcpCatalog({ sessionToken, query }),
  });
}

export function useSkillsCatalog(sessionToken: string | null, query: string) {
  return useQuery<CatalogPage>({
    queryKey: libraryKeys.catalog("skills", query),
    enabled: sessionToken !== null,
    staleTime: 10 * MINUTE,
    placeholderData: (prev) => prev,
    queryFn: () => fetchSkillsCatalog({ sessionToken, query }),
  });
}

export function useCreateLibraryEntry(sessionToken: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      kind: LibraryKind;
      name: string;
      displayName?: string;
      description?: string | null;
      payload: LibraryPayload;
      iconUrl?: string | null;
      source?: "custom" | "catalog";
      catalogId?: string | null;
      scope: LibraryScope;
      scopeId?: string | null;
      visibility?: LibraryVisibility;
    }) => createLibraryEntry({ sessionToken, ...input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: libraryKeys.all });
    },
  });
}

export function useUpdateLibraryEntry(sessionToken: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      entryId: string;
      displayName?: string;
      description?: string | null;
      payload?: LibraryPayload;
      iconUrl?: string | null;
      visibility?: LibraryVisibility;
    }) => updateLibraryEntry({ sessionToken, ...input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: libraryKeys.all });
    },
  });
}

export function useDeleteLibraryEntry(sessionToken: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entryId: string) => deleteLibraryEntry({ sessionToken, entryId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: libraryKeys.all });
    },
  });
}

export function useSetLibraryActivation(sessionToken: string | null) {
  const qc = useQueryClient();
  // Plan-gate denials open the upgrade modal instead of surfacing a raw
  // error to the user. The provider is mounted at the root, so the hook
  // is always available.
  const { handlePlanGateError } = useUpgradeModal();
  return useMutation({
    mutationFn: (input: { entryId: string; active?: boolean; syncTargets?: LibrarySyncTarget[] }) =>
      setLibraryActivation({ sessionToken, ...input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: libraryKeys.all });
    },
    onError: (err) => {
      handlePlanGateError(err);
    },
  });
}
