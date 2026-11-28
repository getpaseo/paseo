import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { SettingsDetailHeader } from "@/components/settings";
import { useIsCompactFormFactor } from "@/constants/layout";
import { ICON_SIZE, type Theme } from "@/styles/theme";
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
      <ThemedProviderGlyph
        serverId={serverId}
        provider={provider}
        uniProps={isCompact ? rowTitleSize : pageTitleSize}
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

// The glyph is as large as the name beside it. The page title scales with the interface size.
const ThemedProviderGlyph = withUnistyles(ProviderGlyph);
const pageTitleSize = (theme: Theme) => ({ size: theme.fontSize["4xl"] });
const rowTitleSize = () => ({ size: ICON_SIZE.md });
