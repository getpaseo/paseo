import { useMemo } from "react";
import { skipToken, useQueries } from "@tanstack/react-query";
import type { ParsedDiffFile, SubscribeCheckoutDiffResponse } from "@getpaseo/protocol/messages";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { checkoutDiffPushRoute } from "@/data/push-router";
import { shareCheckoutDiff } from "@/git/diff-sharing";
import { checkoutDiffQueryKey } from "@/git/query-keys";
import { normalizeCheckoutDiffCompare } from "@/git/use-diff-query";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";

type CheckoutDiffQueryPayload = Omit<SubscribeCheckoutDiffResponse["payload"], "subscriptionId">;

export function prefixSubmoduleNestedPath(subPath: string, nestedPath: string): string {
  return nestedPath ? `${subPath}/${nestedPath}` : subPath;
}

export function prefixSubmoduleNestedFile(
  subPath: string,
  file: ParsedDiffFile,
): ParsedDiffFile {
  return {
    ...file,
    path: prefixSubmoduleNestedPath(subPath, file.path),
    ...(file.oldPath ? { oldPath: prefixSubmoduleNestedPath(subPath, file.oldPath) } : {}),
  };
}

/**
 * Keep submodule stubs in place; when a submodule path is expanded, append its
 * nested checkout-diff files with paths prefixed by the submodule path.
 */
export function mergeExpandedSubmoduleFiles(
  parentFiles: readonly ParsedDiffFile[],
  nestedFilesBySubPath: ReadonlyMap<string, readonly ParsedDiffFile[]>,
): ParsedDiffFile[] {
  const merged: ParsedDiffFile[] = [];
  for (const file of parentFiles) {
    merged.push(file);
    if (file.isSubmodule !== true) {
      continue;
    }
    const nested = nestedFilesBySubPath.get(file.path);
    if (!nested || nested.length === 0) {
      continue;
    }
    for (const nestedFile of nested) {
      merged.push(prefixSubmoduleNestedFile(file.path, nestedFile));
    }
  }
  return merged;
}

interface UseExpandedSubmoduleFilesOptions {
  parentFiles: readonly ParsedDiffFile[];
  serverId: string;
  parentCwd: string;
  mode: "uncommitted" | "base";
  baseRef?: string;
  ignoreWhitespace: boolean;
  /** Submodule paths that are expanded (not in collapsedFilePaths). */
  expandedSubmodulePaths: ReadonlySet<string>;
  enabled?: boolean;
  queryScope?: string;
}

export function useExpandedSubmoduleFiles({
  parentFiles,
  serverId,
  parentCwd,
  mode,
  baseRef,
  ignoreWhitespace,
  expandedSubmodulePaths,
  enabled = true,
  queryScope,
}: UseExpandedSubmoduleFilesOptions): ParsedDiffFile[] {
  const retainedPanelActive = useRetainedPanelActive();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const normalizedCompare = useMemo(
    () => normalizeCheckoutDiffCompare({ mode, baseRef, ignoreWhitespace }),
    [mode, baseRef, ignoreWhitespace],
  );

  const expandedSubs = useMemo(() => {
    if (!enabled) {
      return [] as ParsedDiffFile[];
    }
    return parentFiles.filter(
      (file) => file.isSubmodule === true && expandedSubmodulePaths.has(file.path),
    );
  }, [enabled, expandedSubmodulePaths, parentFiles]);

  const queries = useQueries({
    queries: expandedSubs.map((file) => {
      const subCwd = prefixSubmoduleNestedPath(parentCwd.replace(/\/+$/, ""), file.path);
      // Parent baseRef (e.g. "main") usually does not exist inside the submodule.
      // Prefer the stub's recorded oldCommit so base-mode nested diffs compare that tip to HEAD.
      const nestedBaseRef =
        normalizedCompare.mode === "base"
          ? (file.submodule?.oldCommit ?? normalizedCompare.baseRef)
          : normalizedCompare.baseRef;
      const nestedCompare = normalizeCheckoutDiffCompare({
        mode: normalizedCompare.mode,
        baseRef: nestedBaseRef,
        ignoreWhitespace: normalizedCompare.ignoreWhitespace,
      });
      const comparisonKey = checkoutDiffQueryKey(
        serverId,
        subCwd,
        nestedCompare.mode,
        nestedCompare.baseRef,
        nestedCompare.ignoreWhitespace,
      );
      const normalizedScope = queryScope?.trim();
      const queryKey = normalizedScope
        ? ([...comparisonKey, "scope", normalizedScope] as const)
        : comparisonKey;
      const subscriptionId = `checkoutDiff:${JSON.stringify(queryKey)}`;
      const routeEnabled = Boolean(retainedPanelActive && isConnected && subCwd);
      return {
        queryKey,
        structuralSharing: shareCheckoutDiff,
        enabled: routeEnabled,
        queryFn: skipToken,
        gcTime: Infinity,
        staleTime: Infinity,
        refetchOnMount: false as const,
        refetchOnReconnect: false as const,
        refetchOnWindowFocus: false as const,
        meta: {
          ...checkoutDiffPushRoute({
            enabled: routeEnabled,
            serverId,
            subscriptionId,
            cwd: subCwd,
            compare: {
              mode: nestedCompare.mode,
              ...(nestedCompare.baseRef ? { baseRef: nestedCompare.baseRef } : {}),
              ignoreWhitespace: nestedCompare.ignoreWhitespace,
            },
          }),
          serverDataPolicy: {
            class: "replica" as const,
            pushEvent: "checkout_diff_update",
          },
        },
      };
    }),
  });

  const nestedFilesBySubPath = useMemo(() => {
    const map = new Map<string, ParsedDiffFile[]>();
    for (let i = 0; i < expandedSubs.length; i += 1) {
      const sub = expandedSubs[i]!;
      const payload = (queries[i]?.data ?? null) as CheckoutDiffQueryPayload | null;
      if (!payload || payload.diffTooLarge || payload.error) {
        continue;
      }
      map.set(sub.path, payload.files ?? []);
    }
    return map;
  }, [expandedSubs, queries]);

  return useMemo(
    () => mergeExpandedSubmoduleFiles(parentFiles, nestedFilesBySubPath),
    [nestedFilesBySubPath, parentFiles],
  );
}
