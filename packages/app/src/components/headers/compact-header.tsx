import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { router } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { SidebarMenuToggle } from "@/components/headers/sidebar-menu-toggle";
import {
  IconButtonChromeProvider,
  iconButtonChromeGlyphSize,
  mutedIconColorMapping,
} from "@/components/ui/icon-button-chrome";
import { TOUCH_TARGET } from "@/components/ui/control-sizing";
import { HEADER_INNER_HEIGHT_MOBILE, HEADER_TOP_PADDING_MOBILE } from "@/constants/layout";
import { SPACING } from "@/styles/theme";
import { useTopBandRow } from "@/window-layout";
import type { ShortcutKey } from "@/utils/format-shortcut";

const ThemedArrowLeft = withUnistyles(ArrowLeft);

const NO_SHORTCUT: ShortcutKey[] = [];
const ROW_PADDING = SPACING[3];
const ROW_GAP = SPACING[2];
// Below this the title is unreadable; the row starts below the system's occlusions instead.
const MIN_TITLE_WIDTH = 96;

interface CompactHeaderProps {
  /** The leading island: the sidebar menu, or a back button. */
  navigation: "menu" | "back";
  /** Back button action. Defaults to navigating back. */
  onBack?: () => void;
  title?: string;
  titleTestID?: string;
  /** A line under the title. */
  subtitle?: ReactNode;
  /** Show a placeholder instead of the title while it loads. */
  loading?: boolean;
  /** Icon actions inherit the island chrome through the shared button primitives. */
  actions?: ReactNode;
}

/**
 * The phone header: the navigation button and the screen's actions sit in islands, with the title
 * left-aligned between them. Neither the header nor its islands draw a background, so it reads the
 * same in flow and floating over content (see `FloatingHeaderLayout`, whose fade gives the icons
 * contrast). Its height matches the old flat header, so anything
 * offset by the header height still lines up.
 */
export function CompactHeader({
  navigation,
  onBack,
  title,
  titleTestID,
  subtitle,
  loading = false,
  actions,
}: CompactHeaderProps) {
  const insets = useSafeAreaInsets();
  const [actionsWidth, setActionsWidth] = useState(0);
  const measureActions = useCallback(
    (event: LayoutChangeEvent) => setActionsWidth(event.nativeEvent.layout.width),
    [],
  );
  // The trailing side gives way to the occlusion, so it needs no padding of its own.
  const topBand = useTopBandRow({
    offset: insets.top + HEADER_TOP_PADDING_MOBILE,
    height: HEADER_INNER_HEIGHT_MOBILE,
    minimumWidth:
      ROW_PADDING +
      TOUCH_TARGET +
      ROW_GAP +
      MIN_TITLE_WIDTH +
      (actions ? ROW_GAP + actionsWidth : 0),
  });
  const rootStyle = useMemo(
    () => [
      styles.root,
      {
        paddingTop: insets.top + HEADER_TOP_PADDING_MOBILE + topBand.top,
        paddingRight: Math.max(ROW_PADDING, topBand.trailing),
        marginLeft: insets.left,
        marginRight: insets.right,
      },
    ],
    [insets.top, insets.left, insets.right, topBand.top, topBand.trailing],
  );

  return (
    <IconButtonChromeProvider value="header-island">
      <View ref={topBand.ref} onLayout={topBand.onLayout} style={rootStyle}>
        <View style={styles.row}>
          <View style={styles.island}>
            {navigation === "menu" ? <SidebarMenuToggle /> : <BackButton onBack={onBack} />}
          </View>
          <View style={styles.titleGroup}>
            <CompactHeaderTitle
              loading={loading}
              title={title}
              titleTestID={titleTestID}
              subtitle={subtitle}
            />
          </View>
          {actions ? (
            <View style={styles.island} onLayout={measureActions}>
              {actions}
            </View>
          ) : null}
        </View>
      </View>
    </IconButtonChromeProvider>
  );
}

function CompactHeaderTitle({
  loading,
  title,
  titleTestID,
  subtitle,
}: Pick<CompactHeaderProps, "title" | "titleTestID" | "subtitle"> & { loading: boolean }) {
  if (loading) {
    return <View style={styles.titleSkeleton} />;
  }
  return (
    <>
      {title ? (
        <Text
          style={subtitle ? styles.title : styles.singleLineTitle}
          numberOfLines={1}
          testID={titleTestID}
        >
          {title}
        </Text>
      ) : null}
      {subtitle}
    </>
  );
}

function BackButton({ onBack }: { onBack?: () => void }) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    if (onBack) {
      onBack();
      return;
    }
    router.back();
  }, [onBack]);
  return (
    <HeaderToggleButton
      onPress={handlePress}
      tooltipLabel={t("common.actions.back")}
      tooltipKeys={NO_SHORTCUT}
      tooltipSide="right"
      testID="header-back-button"
      accessibilityRole="button"
      accessibilityLabel={t("common.actions.back")}
    >
      <ThemedArrowLeft
        size={iconButtonChromeGlyphSize("large")}
        strokeWidth={1.5}
        uniProps={mutedIconColorMapping}
      />
    </HeaderToggleButton>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    paddingLeft: ROW_PADDING,
  },
  row: {
    height: HEADER_INNER_HEIGHT_MOBILE,
    flexDirection: "row",
    alignItems: "center",
    gap: ROW_GAP,
  },
  titleGroup: {
    flex: 1,
    minWidth: 0,
    // Both title lines receive the remaining width; text alignment does not size the slot.
    alignItems: "stretch",
  },
  island: {
    flexDirection: "row",
    alignItems: "center",
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    textAlign: "left",
  },
  // A title without a subtitle has the header to itself, so it reads one step larger.
  singleLineTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    textAlign: "left",
  },
  titleSkeleton: {
    width: 140,
    maxWidth: "100%",
    height: 22,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    opacity: 0.25,
  },
}));
