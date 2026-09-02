import type { ProviderAccountProfile } from "@getpaseo/protocol/provider-accounts";
import { providerAccountCopy as copy } from "./copy";

export function resolveProviderAccountLabel(
  accountProfileId: string | null | undefined,
  accounts: readonly ProviderAccountProfile[],
): string | null {
  if (accountProfileId === undefined) return null;
  if (accountProfileId === null) return copy.system;
  return (
    accounts.find((account) => account.id === accountProfileId)?.name ?? copy.unavailableAccount
  );
}
