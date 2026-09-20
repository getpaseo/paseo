import { useCallback, useMemo } from "react";
import { ArrowLeft } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { HeaderToggleButton } from "./header-toggle-button";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  navigateBackInFocusHistory,
  useCanNavigateBackInFocusHistory,
} from "@/navigation/focus-history-runtime";
import type { ShortcutKey } from "@/utils/format-shortcut";
import type { Theme } from "@/styles/theme";

const ThemedArrowLeft = withUnistyles(ArrowLeft);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const extraMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

export function NavigationBackButton() {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const canGoBack = useCanNavigateBackInFocusHistory();
  const shortcutKeys = useMemo<ShortcutKey[]>(() => (isCompact ? [] : ["mod", "["]), [isCompact]);
  const accessibilityState = useMemo(() => ({ disabled: !canGoBack }), [canGoBack]);
  const handlePress = useCallback(() => {
    navigateBackInFocusHistory({ isCompact });
  }, [isCompact]);

  return (
    <HeaderToggleButton
      testID="navigation-back-button"
      onPress={handlePress}
      disabled={!canGoBack}
      tooltipLabel={t("common.actions.back")}
      tooltipKeys={shortcutKeys}
      tooltipSide="bottom"
      accessibilityRole="button"
      accessibilityLabel={t("common.actions.back")}
      accessibilityState={accessibilityState}
    >
      {({ hovered, pressed }) => {
        let colorMapping = mutedColorMapping;
        if (!canGoBack) {
          colorMapping = extraMutedColorMapping;
        } else if (hovered || pressed) {
          colorMapping = foregroundColorMapping;
        }
        return <ThemedArrowLeft size={16} uniProps={colorMapping} />;
      }}
    </HeaderToggleButton>
  );
}
