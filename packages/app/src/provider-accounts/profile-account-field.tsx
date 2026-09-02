import { useCallback, useMemo, type ReactElement } from "react";
import type { ProviderAccountProvider } from "@getpaseo/protocol/provider-accounts";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { providerAccountCopy as copy } from "./copy";
import { useProviderAccounts } from "./use-provider-accounts";

const DEFAULT_ACCOUNT_VALUE = "__host_default__";
const SYSTEM_ACCOUNT_VALUE = "__system_account__";

function supportedProvider(provider: string): ProviderAccountProvider | null {
  return provider === "codex" || provider === "claude" ? provider : null;
}

export function ProfileAccountField({
  serverId,
  provider,
  accountProfileId,
  onChange,
  disabled,
  size,
}: {
  serverId: string;
  provider: string;
  accountProfileId: string | null | undefined;
  onChange: (accountProfileId: string | null | undefined) => void;
  disabled: boolean;
  size: FieldControlSize;
}): ReactElement | null {
  const providerAccounts = useProviderAccounts(serverId);
  const accountProvider = supportedProvider(provider);
  const accountOptions = useMemo<SelectFieldOption<string>[]>(() => {
    if (!accountProvider) return [];
    const matching = providerAccounts.accounts.filter(
      (account) => account.provider === accountProvider,
    );
    const defaultId = providerAccounts.defaults[accountProvider] ?? null;
    const defaultName = matching.find((account) => account.id === defaultId)?.name;
    const options: SelectFieldOption<string>[] = [
      {
        id: DEFAULT_ACCOUNT_VALUE,
        value: DEFAULT_ACCOUNT_VALUE,
        label: copy.hostDefaultWithAccount(defaultName ?? copy.system),
      },
      { id: SYSTEM_ACCOUNT_VALUE, value: SYSTEM_ACCOUNT_VALUE, label: copy.system },
      ...matching.map((account) => ({
        id: account.id,
        value: account.id,
        label: account.name,
        description: account.identity?.email ?? undefined,
      })),
    ];
    if (
      typeof accountProfileId === "string" &&
      !matching.some((account) => account.id === accountProfileId)
    ) {
      options.push({
        id: accountProfileId,
        value: accountProfileId,
        label: copy.unavailableAccount,
        description: accountProfileId,
      });
    }
    return options;
  }, [accountProfileId, accountProvider, providerAccounts.accounts, providerAccounts.defaults]);
  const value =
    accountProfileId === undefined
      ? DEFAULT_ACCOUNT_VALUE
      : (accountProfileId ?? SYSTEM_ACCOUNT_VALUE);
  const selectedDisplay = useMemo<SelectFieldDisplay | null>(() => {
    const option = accountOptions.find((entry) => entry.value === value);
    return option ? { label: option.label, description: option.description } : null;
  }, [accountOptions, value]);
  const handleChange = useCallback(
    (next: string) => {
      if (next === DEFAULT_ACCOUNT_VALUE) onChange(undefined);
      else if (next === SYSTEM_ACCOUNT_VALUE) onChange(null);
      else onChange(next);
    },
    [onChange],
  );

  if (providerAccounts.view.kind !== "ready" || accountOptions.length === 0) return null;
  return (
    <SelectField
      label={copy.account}
      value={value}
      selectedDisplay={selectedDisplay}
      options={accountOptions}
      onChange={handleChange}
      placeholder={copy.hostDefault}
      emptyText={copy.noAccounts}
      disabled={disabled}
      searchable={accountOptions.length > 6}
      title={copy.account}
      size={size}
      testID="agent-profile-account-field"
      triggerTestID="agent-profile-account-trigger"
    />
  );
}
