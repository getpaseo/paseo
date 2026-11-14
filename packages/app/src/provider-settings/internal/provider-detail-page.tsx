import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { SettingsDetailHeader } from "@/components/settings";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { resolveProviderLabel } from "@/utils/provider-definitions";
import { ProviderDetail } from "./provider-detail";
import { ProviderGlyph } from "./provider-glyph";

/**
 * A provider's detail as a Settings page. On wide layouts the page has no header of its own, so it
 * draws "Back to providers" and the provider's name; on compact ones the screen's header does.
 */
export function ProviderDetailPage({
  serverId,
  provider,
  onBack,
  showHeader,
}: {
  serverId: string;
  provider: string;
  onBack: () => void;
  showHeader: boolean;
}) {
  const { t } = useTranslation();
  const { entries } = useProvidersSnapshot(serverId);
  const back = useMemo(
    () => ({
      label: t("settings.providers.detail.backToProviders"),
      onPress: onBack,
      testID: "provider-detail-back",
    }),
    [onBack, t],
  );
  const icon = useMemo(
    () => <ProviderGlyph serverId={serverId} provider={provider} />,
    [provider, serverId],
  );
  return (
    <View testID="provider-detail-page">
      {showHeader ? (
        <SettingsDetailHeader
          back={back}
          icon={icon}
          title={resolveProviderLabel(provider, entries)}
          titleTestID="provider-detail-title"
        />
      ) : null}
      <ProviderDetail serverId={serverId} provider={provider} onRemoved={onBack} />
    </View>
  );
}

/** The provider's name, for a screen header that titles the page. */
export function useProviderLabel(
  target: { serverId: string; providerId: string } | null,
): string | undefined {
  const { entries } = useProvidersSnapshot(target?.serverId ?? null);
  return target ? resolveProviderLabel(target.providerId, entries) : undefined;
}
