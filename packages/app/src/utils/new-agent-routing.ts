import type { CheckoutStatusPayload } from "@/hooks/use-checkout-status-query";

export function resolveNewAgentWorkingDir(
  cwd: string,
  checkout: CheckoutStatusPayload | null
): string {
  return (checkout?.isPaseoOwnedWorktree ? checkout.mainRepoRoot : null) ?? cwd;
}

export function buildNewAgentRoute(workingDir?: string | null): string {
  const trimmedWorkingDir = workingDir?.trim();
  if (!trimmedWorkingDir) {
    return "/agent";
  }
  return `/agent?workingDir=${encodeURIComponent(trimmedWorkingDir)}`;
}
