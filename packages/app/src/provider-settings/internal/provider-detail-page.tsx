import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { SettingsDetailHeader } from "@/components/settings";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { resolveProviderLabel } from "@/utils/provider-definitions";
import { ProviderDetail } from "./provider-detail";
import { ProviderGlyph } from "./provider-glyph";

/**
 * A provider's detail as a Settings page, shaped like a project's: the screen titles it
 * "Providers", the page names the provider. On wide layouts the page has no back button of its
 * own, so it draws "Back to providers".
 */
export function ProviderDetailPage({
  serverId,
  provider,
  onBack,
  showBack,
}: {
  serverId: string;
  provider: string;
  onBack: () => void;
  showBack: boolean;
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
      <SettingsDetailHeader
        back={showBack ? back : undefined}
        icon={icon}
        title={resolveProviderLabel(provider, entries)}
        titleTestID="provider-detail-title"
      />
      <ProviderDetail serverId={serverId} provider={provider} onRemoved={onBack} />
    </View>
  );
}
