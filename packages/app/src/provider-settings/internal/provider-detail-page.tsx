import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { SettingsDetailHeader } from "@/components/settings";
import { useIsCompactFormFactor } from "@/constants/layout";
import { FONT_SIZE, ICON_SIZE } from "@/styles/theme";
import { ProviderDetail, useProviderDetail } from "./provider-detail";
import { ProviderGlyph } from "./provider-glyph";

/**
 * A provider's detail as a Settings page, shaped like a project's. On wide layouts the page is
 * titled "Providers > name" and "Providers" goes back. On compact layouts the screen titles it
 * "Providers" and the page names the provider.
 */
export function ProviderDetailPage({
  serverId,
  provider,
  onBack,
}: {
  serverId: string;
  provider: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const detail = useProviderDetail({ serverId, provider, onRemoved: onBack });
  const parent = useMemo(
    () => ({
      label: t("settings.hostSections.providers"),
      accessibilityLabel: t("settings.providers.detail.backToProviders"),
      onPress: onBack,
      testID: "provider-detail-back",
    }),
    [onBack, t],
  );
  const icon = useMemo(
    () => (
      <ProviderGlyph
        serverId={serverId}
        provider={provider}
        // As large as the name beside it: the page title on wide layouts, a row title on compact.
        size={isCompact ? ICON_SIZE.md : FONT_SIZE["4xl"]}
      />
    ),
    [isCompact, provider, serverId],
  );
  return (
    <View testID="provider-detail-page">
      <SettingsDetailHeader
        parent={parent}
        icon={icon}
        title={detail.label}
        titleTestID="provider-detail-title"
      />
      <ProviderDetail serverId={serverId} detail={detail} />
    </View>
  );
}
