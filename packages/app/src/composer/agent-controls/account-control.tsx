import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { CircleUserRound } from "lucide-react-native";
import type { ProviderAccountProvider } from "@getpaseo/protocol/provider-accounts";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { providerAccountCopy as copy } from "@/provider-accounts/copy";
import { useProviderAccounts } from "@/provider-accounts";

const DEFAULT_VALUE = "__provider_account_default__";
const SYSTEM_VALUE = "__provider_account_system__";

function supportedProvider(provider: string): ProviderAccountProvider | null {
  return provider === "codex" || provider === "claude" ? provider : null;
}

export interface AgentAccountControlValue {
  serverId: string | null;
  provider: string;
  selectedAccountProfileId: string | null | undefined;
  onSelectAccountProfile: (accountProfileId: string | null | undefined) => void;
  disabled?: boolean;
}

export function AgentAccountControl({
  serverId,
  provider,
  selectedAccountProfileId,
  onSelectAccountProfile,
  disabled = false,
  surface = "toolbar",
  onClose,
}: AgentAccountControlValue & {
  surface?: "toolbar" | "sheet";
  onClose?: () => void;
}): ReactElement | null {
  const { view, accounts, defaults } = useProviderAccounts(serverId);
  const accountProvider = supportedProvider(provider);
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const matching = useMemo(
    () => accounts.filter((account) => account.provider === accountProvider),
    [accountProvider, accounts],
  );
  const defaultId = accountProvider ? (defaults[accountProvider] ?? null) : null;
  const defaultName = matching.find((account) => account.id === defaultId)?.name ?? copy.system;
  const options = useMemo<ComboboxOption[]>(() => {
    const rows: ComboboxOption[] = [
      { id: DEFAULT_VALUE, label: copy.hostDefaultWithAccount(defaultName) },
      { id: SYSTEM_VALUE, label: copy.system, description: copy.systemHint },
      ...matching.map((account) => ({
        id: account.id,
        label: account.name,
        description: account.identity?.email ?? undefined,
      })),
    ];
    if (
      typeof selectedAccountProfileId === "string" &&
      !matching.some((account) => account.id === selectedAccountProfileId)
    ) {
      rows.push({
        id: selectedAccountProfileId,
        label: copy.unavailableAccount,
        description: selectedAccountProfileId,
      });
    }
    return rows;
  }, [defaultName, matching, selectedAccountProfileId]);
  const selectedValue =
    selectedAccountProfileId === undefined
      ? DEFAULT_VALUE
      : (selectedAccountProfileId ?? SYSTEM_VALUE);
  const selectedLabel =
    options.find((option) => option.id === selectedValue)?.label ?? copy.hostDefault;
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      const wasOpen = open;
      setOpen(nextOpen);
      if (wasOpen && !nextOpen) onClose?.();
    },
    [onClose, open],
  );
  const handlePress = useCallback(() => handleOpenChange(!open), [handleOpenChange, open]);
  const handleSelect = useCallback(
    (id: string) => {
      if (id === DEFAULT_VALUE) onSelectAccountProfile(undefined);
      else if (id === SYSTEM_VALUE) onSelectAccountProfile(null);
      else onSelectAccountProfile(id);
      handleOpenChange(false);
    },
    [handleOpenChange, onSelectAccountProfile],
  );

  if (
    !accountProvider ||
    view.kind !== "ready" ||
    (matching.length === 0 && typeof selectedAccountProfileId !== "string")
  ) {
    return null;
  }
  return (
    <>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild triggerRefProp="ref">
          <AgentControlTrigger
            ref={anchorRef}
            icon={CircleUserRound}
            surface={surface}
            label={copy.account}
            value={selectedLabel}
            showToolbarLabel={false}
            open={open}
            disabled={disabled}
            onPress={handlePress}
            accessibilityLabel={`${copy.account}: ${selectedLabel}`}
            testID="provider-account-control"
          />
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text>{selectedLabel}</Text>
        </TooltipContent>
      </Tooltip>
      <Combobox
        options={options}
        value={selectedValue}
        onSelect={handleSelect}
        open={open}
        onOpenChange={handleOpenChange}
        anchorRef={anchorRef}
        desktopPlacement="top-start"
        desktopMinWidth={260}
        searchable={options.length > 6}
        title={copy.account}
      />
    </>
  );
}
