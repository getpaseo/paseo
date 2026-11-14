import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { SettingsDetailHeader } from "@/components/settings";
import { ProviderDetail, useProviderDetail } from "./provider-detail";
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
  const detail = useProviderDetail({ serverId, provider, onRemoved: onBack });
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
        title={detail.label}
        titleTestID="provider-detail-title"
      />
      <ProviderDetail serverId={serverId} detail={detail} />
    </View>
  );
}
