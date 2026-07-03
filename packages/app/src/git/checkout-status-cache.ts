import type { QueryClient } from "@tanstack/react-query";
import type { CheckoutStatusResponse, CheckoutStatusUpdate } from "@getpaseo/protocol/messages";
import equal from "fast-deep-equal/es6";
import {
  checkoutPrStatusQueryKey,
  checkoutStatusQueryKey,
  invalidatePrPaneTimelineForCheckout,
} from "@/git/query-keys";
import { expireStaleDiffModeOverrides } from "@/review/store";

export type CheckoutStatusPayload = CheckoutStatusResponse["payload"];
export type CheckoutPrStatusPayload = NonNullable<CheckoutStatusUpdate["payload"]["prStatus"]>;

export interface CheckoutStatusClient {
  getCheckoutStatus: (cwd: string) => Promise<CheckoutStatusPayload>;
}

// Checkout status enters the app through exactly two doors: daemon pushes
// (applyCheckoutStatusUpdateFromEvent) and query fetches (fetchCheckoutStatus). Both run
// the dirty-state reactions, so they hold regardless of which screens are mounted.

export async function fetchCheckoutStatus({
  client,
  serverId,
  cwd,
}: {
  client: CheckoutStatusClient;
  serverId: string;
  cwd: string;
}): Promise<CheckoutStatusPayload> {
  const payload = await client.getCheckoutStatus(cwd);
  expireStaleDiffModeOverrides({ serverId, cwd, isDirty: payload.isGit && payload.isDirty });
  return payload;
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
  queryClient.setQueryData(checkoutStatusQueryKey(serverId, payload.cwd), payload);
  expireStaleDiffModeOverrides({
    serverId,
    cwd: payload.cwd,
    isDirty: payload.isGit && payload.isDirty,
  });

  // Notify dirty-state subscribers so panes that don't use React Query (file explorer)
  // can refresh when files change during tool-use.
  notifyDirtyStateChanges(serverId, payload.cwd, !!payload.isDirty);

  const prStatus = payload.prStatus;
  if (!prStatus) {
    return;
  }

  const previous = queryClient.getQueryData<CheckoutPrStatusPayload>(
    checkoutPrStatusQueryKey(serverId, prStatus.cwd),
  );
  queryClient.setQueryData(checkoutPrStatusQueryKey(serverId, prStatus.cwd), prStatus);

  // The PR activity timeline has no push channel; mark it stale when the pushed PR status
  // meaningfully changed. Active panes refetch immediately, evicted ones on next mount.
  if (hasPrStatusChanged(previous, prStatus)) {
    void invalidatePrPaneTimelineForCheckout(queryClient, { serverId, cwd: prStatus.cwd });
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

// ---------------------------------------------------------------------------
// Dirty-state change notifications — push-driven refresh trigger for panes
// that don't use React Query (file explorer). Subscribers get called once per
// isDirty flip (clean→dirty or dirty→clean) for their serverId/cwd pair.
// ---------------------------------------------------------------------------
type DirtyStateCallback = () => void;

interface DirtyListenerEntry {
  callback: DirtyStateCallback;
  serverId: string;
  cwd: string;
}

const dirtyListeners = new Map<string, Set<DirtyListenerEntry>>();

export function subscribeToDirtyStateChange(
  serverId: string,
  cwd: string,
  callback: DirtyStateCallback,
): () => void {
  const key = `${serverId}::${cwd}`;
  let set = dirtyListeners.get(key);
  if (!set) {
    set = new Set();
    dirtyListeners.set(key, set);
  }
  set.add({ callback, serverId, cwd });

  return () => {
    const currentSet = dirtyListeners.get(key);
    currentSet?.delete({ callback, serverId, cwd });
    if (currentSet?.size === 0) {
      dirtyListeners.delete(key);
    }
  };
}

// Last-known dirty flip per checkout, keyed by serverId::cwd. Cleared when all listeners
// unsubscribe so we don't leak across checkouts or stale subscriptions.
const lastDirtyFlip = new Map<string, boolean>();

function notifyDirtyStateChanges(serverId: string, cwd: string, isDirty: boolean): void {
  const key = `${serverId}::${cwd}`;
  const entrySet = dirtyListeners.get(key);
  if (!entrySet || entrySet.size === 0) {
    return;
  }

  const prev = lastDirtyFlip.get(key);
  lastDirtyFlip.set(key, isDirty);

  // Only fire on flip (first observation always fires).
  if (prev !== undefined && prev === isDirty) {
    return;
  }

  for (const entry of entrySet) {
    try {
      entry.callback();
    } catch {
      // Don't let a crashing listener break the update chain.
    }
  }
}
