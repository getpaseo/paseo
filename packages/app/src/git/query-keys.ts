import type { Query, QueryClient } from "@tanstack/react-query";
import {
  workspaceGitQueryIdentitiesEqual,
  type WorkspaceGitQueryIdentity,
  type WorkspaceGitStatusTarget,
  type WorkspaceGitTarget,
} from "./workspace-git";
import { prPanePipelineQueryKind, prPaneTimelineQueryKind } from "./pull-request-panel/query-keys";

interface CheckoutQueryIdentity {
  serverId: string;
  target: WorkspaceGitTarget;
}

interface CheckoutQueryScope {
  serverId: string;
  target?: WorkspaceGitTarget;
}

type CheckoutQueryKey = readonly unknown[];

// A commit's file diff is immutable for a given sha+path, so every consumer
// can share the same long-lived cache policy.
export const COMMIT_FILE_DIFF_STALE_TIME = 5 * 60_000;

export function checkoutStatusQueryKey(serverId: string, target: WorkspaceGitStatusTarget) {
  return ["checkoutStatus", serverId, target.queryIdentity, target.cwd] as const;
}

export function legacyCheckoutStatusQueryKey(serverId: string, cwd: string) {
  return ["legacyCheckoutStatus", serverId, cwd] as const;
}

export function checkoutDiffQueryKey(
  serverId: string,
  target: WorkspaceGitTarget,
  mode: "uncommitted" | "base",
  baseRef?: string,
  ignoreWhitespace?: boolean,
) {
  return [
    "checkoutDiff",
    serverId,
    target.queryIdentity,
    target.cwd,
    mode,
    baseRef ?? "",
    ignoreWhitespace === true,
  ] as const;
}

export function checkoutPrStatusQueryKey(serverId: string, target: WorkspaceGitStatusTarget) {
  return ["checkoutPrStatus", serverId, target.queryIdentity, target.cwd] as const;
}

export function checkoutCommitsQueryKey(serverId: string, target: WorkspaceGitTarget) {
  return ["checkoutCommits", serverId, target.queryIdentity, target.cwd] as const;
}

export function checkoutCommitFileDiffQueryKey(
  serverId: string,
  target: WorkspaceGitTarget,
  sha: string,
  path: string,
) {
  return ["checkoutCommitFileDiff", serverId, target.queryIdentity, target.cwd, sha, path] as const;
}

export async function invalidateCheckoutGitQueriesForClient(
  queryClient: QueryClient,
  identity: CheckoutQueryIdentity,
) {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: checkoutStatusQueryKey(identity.serverId, identity.target),
    }),
    queryClient.invalidateQueries({
      predicate: checkoutQueryPredicate("checkoutDiff", identity),
    }),
    queryClient.invalidateQueries({
      predicate: checkoutQueryPredicate("checkoutPrStatus", identity),
    }),
    queryClient.invalidateQueries({
      queryKey: checkoutCommitsQueryKey(identity.serverId, identity.target),
    }),
    queryClient.invalidateQueries({
      predicate: checkoutQueryPredicate(prPaneTimelineQueryKind, identity),
    }),
    queryClient.invalidateQueries({
      predicate: checkoutQueryPredicate(prPanePipelineQueryKind, identity),
    }),
  ]);
}

// checkoutDiff is excluded: diff queries are subscription-fed (queryFn: skipToken) and
// receive a fresh snapshot on every resubscribe, so invalidation cannot and need not
// refetch them.
export async function invalidateCheckoutGitQueriesForServer(
  queryClient: QueryClient,
  serverId: string,
) {
  const kinds = [
    "checkoutStatus",
    "checkoutPrStatus",
    "checkoutCommits",
    prPaneTimelineQueryKind,
    prPanePipelineQueryKind,
  ];
  await Promise.all(
    kinds.map((kind) =>
      queryClient.invalidateQueries({ predicate: checkoutQueryPredicate(kind, { serverId }) }),
    ),
  );
}

export async function invalidatePrPaneTimelineForCheckout(
  queryClient: QueryClient,
  identity: CheckoutQueryIdentity,
) {
  await Promise.all([
    queryClient.invalidateQueries({
      predicate: checkoutQueryPredicate(prPaneTimelineQueryKind, identity),
    }),
    queryClient.invalidateQueries({
      predicate: checkoutQueryPredicate(prPanePipelineQueryKind, identity),
    }),
  ]);
}

function checkoutQueryPredicate(
  queryKind: CheckoutQueryKey[0],
  scope: CheckoutQueryScope,
): (query: Query) => boolean {
  return (query) => {
    const key = query.queryKey;
    return (
      isCheckoutQueryKey(key) &&
      key[0] === queryKind &&
      key[1] === scope.serverId &&
      (scope.target === undefined ||
        (isWorkspaceGitQueryIdentity(key[2]) &&
          workspaceGitQueryIdentitiesEqual(key[2], scope.target.queryIdentity) &&
          key[3] === scope.target.cwd))
    );
  };
}

function isCheckoutQueryKey(key: readonly unknown[]): key is CheckoutQueryKey {
  return (
    key.length >= 4 &&
    typeof key[0] === "string" &&
    typeof key[1] === "string" &&
    isWorkspaceGitQueryIdentity(key[2]) &&
    typeof key[3] === "string"
  );
}

function isWorkspaceGitQueryIdentity(value: unknown): value is WorkspaceGitQueryIdentity {
  return (
    Array.isArray(value) &&
    (value[0] === "selected" || value[0] === "legacy") &&
    typeof value[1] === "string"
  );
}
