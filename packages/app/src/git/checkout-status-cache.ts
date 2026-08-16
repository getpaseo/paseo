import type { QueryClient } from "@tanstack/react-query";
import type { CheckoutStatusResponse, CheckoutStatusUpdate } from "@getpaseo/protocol/messages";
import equal from "fast-deep-equal/es6";
import {
  checkoutCommitsQueryKey,
  checkoutPrStatusQueryKey,
  checkoutStatusQueryKey,
  legacyCheckoutStatusQueryKey,
  invalidatePrPaneTimelineForCheckout,
} from "@/git/query-keys";
import { type CheckoutPrStatusPayload, normalizeCheckoutPrStatusPayload } from "@/git/pr-status";
import { expireStaleDiffModeOverrides } from "@/review/store";
import type { WorkspaceGitClient, WorkspaceGitStatusTarget } from "./workspace-git";

export type CheckoutStatusPayload = CheckoutStatusResponse["payload"];
export type { CheckoutPrStatusPayload } from "@/git/pr-status";

export interface CheckoutStatusClient {
  getStatus: WorkspaceGitClient["getStatus"];
}

export interface LegacyCheckoutStatusClient {
  getCheckoutStatus: (cwd: string) => Promise<CheckoutStatusPayload>;
}

// Checkout status enters the app through exactly two doors: daemon pushes
// (applyCheckoutStatusUpdateFromEvent) and query fetches (fetchCheckoutStatus). Both run
// the dirty-state reactions, so they hold regardless of which screens are mounted.

export async function fetchCheckoutStatus({
  client,
  serverId,
  target,
}: {
  client: CheckoutStatusClient;
  serverId: string;
  target: WorkspaceGitStatusTarget;
}): Promise<CheckoutStatusPayload> {
  const payload = await client.getStatus();
  expireStaleDiffModeOverrides({
    serverId,
    cwd: target.cwd,
    isDirty: payload.isGit && payload.isDirty,
  });
  return payload;
}

export async function ensureCheckoutStatus({
  queryClient,
  client,
  serverId,
  target,
}: {
  queryClient: QueryClient;
  client: CheckoutStatusClient;
  serverId: string;
  target: WorkspaceGitStatusTarget;
}): Promise<CheckoutStatusPayload> {
  return await queryClient.fetchQuery({
    queryKey: checkoutStatusQueryKey(serverId, target),
    queryFn: () => fetchCheckoutStatus({ client, serverId, target }),
    staleTime: Infinity,
  });
}

export async function ensureLegacyCheckoutStatus({
  queryClient,
  client,
  serverId,
  cwd,
}: {
  queryClient: QueryClient;
  client: LegacyCheckoutStatusClient;
  serverId: string;
  cwd: string;
}): Promise<CheckoutStatusPayload> {
  return await queryClient.fetchQuery({
    queryKey: legacyCheckoutStatusQueryKey(serverId, cwd),
    queryFn: async () => {
      const payload = await client.getCheckoutStatus(cwd);
      expireStaleDiffModeOverrides({ serverId, cwd, isDirty: payload.isGit && payload.isDirty });
      return payload;
    },
    staleTime: Infinity,
  });
}

export function applyCheckoutStatusUpdateFromEvent({
  queryClient,
  serverId,
  message,
}: {
  queryClient: QueryClient;
  serverId: string;
  message: CheckoutStatusUpdate;
}): void {
  const { payload } = message;
  const prStatus = payload.prStatus
    ? normalizeCheckoutPrStatusPayload(payload.prStatus)
    : undefined;
  const cachePayload = prStatus ? { ...payload, prStatus } : payload;
  if (payload.workspaceId === undefined) return;
  const target = {
    workspaceId: payload.workspaceId,
    cwd: payload.cwd,
    queryIdentity: ["selected", payload.workspaceId] as const,
  };
  queryClient.setQueryData(checkoutStatusQueryKey(serverId, target), cachePayload);
  void queryClient.invalidateQueries({
    queryKey: checkoutCommitsQueryKey(serverId, target),
  });
  expireStaleDiffModeOverrides({
    serverId,
    cwd: payload.cwd,
    isDirty: payload.isGit && payload.isDirty,
  });

  if (!prStatus) {
    return;
  }

  const previous = queryClient.getQueryData<CheckoutPrStatusPayload>(
    checkoutPrStatusQueryKey(serverId, target),
  );
  queryClient.setQueryData(checkoutPrStatusQueryKey(serverId, target), prStatus);

  // The PR activity timeline has no push channel; mark it stale when the pushed PR status
  // meaningfully changed. Active panes refetch immediately, evicted ones on next mount.
  if (hasPrStatusChanged(previous, prStatus)) {
    void invalidatePrPaneTimelineForCheckout(queryClient, { serverId, target });
  }
}

// requestId changes on every emission and carries no PR state.
function prStatusWithoutVolatileFields(
  prStatus: CheckoutPrStatusPayload,
): Omit<CheckoutPrStatusPayload, "requestId"> {
  const { requestId: _requestId, ...rest } = prStatus;
  return rest;
}

function hasPrStatusChanged(
  previous: CheckoutPrStatusPayload | undefined,
  next: CheckoutPrStatusPayload,
): boolean {
  if (!previous) {
    return true;
  }
  return !equal(prStatusWithoutVolatileFields(previous), prStatusWithoutVolatileFields(next));
}
