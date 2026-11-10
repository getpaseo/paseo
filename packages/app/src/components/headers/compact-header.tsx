import { useCallback, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
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
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
} from "@/constants/layout";
import type { ShortcutKey } from "@/utils/format-shortcut";
import {
  resolveHeaderBesideStatusBar,
  useTopBand,
  useVerticalBarDisabled,
  useWindowLayout,
} from "@/window-layout";

const ThemedArrowLeft = withUnistyles(ArrowLeft);

const NO_SHORTCUT: ShortcutKey[] = [];

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
  /** Fills the control row when the header splits beside the status pill, e.g. a tab strip. */
  strip?: ReactNode;
}

/**
 * The phone header: the navigation button and the screen's actions sit in islands, with the title
 * left-aligned between them. Neither the header nor its islands draw a background, so it reads the
 * same in flow and floating over content (see `FloatingHeaderLayout`, whose fade gives the icons
 * contrast). Its height matches the old flat header, so anything
 * offset by the header height still lines up. In a window's top band it takes the top bar's
 * place, like the full header. The column hosting it reserves any window-chrome corner it owns.
 */
export function CompactHeader({
  navigation,
  onBack,
  title,
  titleTestID,
  subtitle,
  loading = false,
  actions,
  strip,
}: CompactHeaderProps) {
  const insets = useSafeAreaInsets();
  const inTopBand = useTopBand() !== null;
  const layout = useWindowLayout();
  const verticalBarDisabled = useVerticalBarDisabled();
  // With the vertical bar off the status bar returns to the top inset, which already clears it.
  // A top band already starts at the top bar, so it takes no extra padding either.
  const topPadding = verticalBarDisabled || inTopBand ? 0 : HEADER_TOP_PADDING_MOBILE;
  const beside = resolveHeaderBesideStatusBar(layout, HEADER_INNER_HEIGHT_MOBILE);
  const rootStyle = useMemo(
    () => [
      styles.root,
      {
        paddingTop: beside ? beside.top : insets.top + topPadding,
        marginLeft: insets.left,
        marginRight: insets.right,
      },
    ],
    [beside, insets.top, insets.left, insets.right, topPadding],
  );
  // Beside the status pill the top row holds the title alone; the buttons take the next line.
  const titleRowStyle = useMemo(
    () => [
      styles.row,
      beside && { marginRight: Math.max(0, beside.right - insets.right - ROOT_PADDING) },
    ],
    [beside, insets.right],
  );

  const leading = (
    <View style={styles.island}>
      {navigation === "menu" ? <SidebarMenuToggle /> : <BackButton onBack={onBack} />}
    </View>
  );
  const titleGroup = (
    <View style={styles.titleGroup}>
      <CompactHeaderTitle
        loading={loading}
        title={title}
        titleTestID={titleTestID}
        subtitle={subtitle}
      />
    </View>
  );
  const trailing = actions ? <View style={styles.island}>{actions}</View> : null;

  return (
    <IconButtonChromeProvider value="header-island">
      <View style={rootStyle}>
        {beside ? (
          <>
            <View style={titleRowStyle}>{titleGroup}</View>
            <View style={styles.row}>
              {leading}
              {strip ?? <View style={styles.spacer} />}
              {trailing}
            </View>
          </>
        ) : (
          <View style={inTopBand ? styles.topBandRow : styles.row}>
            {leading}
            {titleGroup}
            {trailing}
          </View>
        )}
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

/** The root's horizontal padding, `theme.spacing[3]`. */
const ROOT_PADDING = 12;

const styles = StyleSheet.create((theme) => ({
  root: {
    paddingHorizontal: ROOT_PADDING,
  },
  spacer: { flex: 1 },
  row: {
    height: HEADER_INNER_HEIGHT_MOBILE,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  topBandRow: {
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
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
