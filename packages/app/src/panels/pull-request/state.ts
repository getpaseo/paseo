import type { CheckoutPrStatusResponse } from "@getpaseo/protocol/messages";

type PullRequestStatus = CheckoutPrStatusResponse["payload"]["status"];

export function getPullRequestIdentity(status: PullRequestStatus): string | null {
  if (!status) {
    return null;
  }
  const url = status.url.trim();
  if (url) {
    return `url:${url}`;
  }
  if (status.number === undefined) {
    return null;
  }
  return `repo:${status.forge}:${status.repoOwner ?? ""}/${status.repoName ?? ""}#${status.number}`;
}

export function resolvePullRequestContentState(input: {
  data: unknown;
  error: Error | null;
  isLoading: boolean;
}): "ready" | "error" | "loading" | "empty" {
  if (input.data) return "ready";
  if (input.error) return "error";
  if (input.isLoading) return "loading";
  return "empty";
}
