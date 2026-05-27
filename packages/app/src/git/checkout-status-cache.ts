import type { QueryClient } from "@tanstack/react-query";
import type { CheckoutStatusResponse, CheckoutStatusUpdate } from "@getpaseo/protocol/messages";
import { checkoutStatusQueryKey } from "@/git/query-keys";

export type CheckoutStatusPayload = CheckoutStatusResponse["payload"];

export interface CheckoutStatusClient {
  getCheckoutStatus: (cwd: string) => Promise<CheckoutStatusPayload>;
}

export async function peekOrFetchCheckoutStatus({
  queryClient,
  client,
  serverId,
  cwd,
}: {
  queryClient: QueryClient;
  client: CheckoutStatusClient;
  serverId: string;
  cwd: string;
}): Promise<CheckoutStatusPayload> {
  const queryKey = checkoutStatusQueryKey(serverId, cwd);
  const cached = queryClient.getQueryData<CheckoutStatusPayload>(queryKey);
  if (cached) {
    return cached;
  }

  const snapshot = await client.getCheckoutStatus(cwd);
  queryClient.setQueryData(queryKey, snapshot);
  return snapshot;
}

export function applyCheckoutStatusUpdate({
  queryClient,
  serverId,
  cwd,
  message,
}: {
  queryClient: QueryClient;
  serverId: string;
  cwd: string;
  message: CheckoutStatusUpdate;
}): void {
  if (message.payload.cwd !== cwd) {
    return;
  }
  queryClient.setQueryData(checkoutStatusQueryKey(serverId, cwd), message.payload);
}
