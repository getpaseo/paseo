import { AppearanceText as Text } from "@/appearance/text";
import { ChevronRight } from "lucide-react-native";
import { useMemo, type ReactNode } from "react";
import { Platform, ScrollView, View, type PressableStateCallbackType } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { MenuHeader } from "@/components/headers/menu-header";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import { ICON_SIZE, SPACING, type Theme } from "@/styles/theme";

const PageScrollView = Platform.OS === "android" ? KeyboardAwareScrollView : ScrollView;

interface PageLayoutProps {
  title?: string;
  /** Compact back button. Defaults to navigating back. */
  onBack?: () => void;
  testID?: string;
  titleTestID?: string;
  /** Controls for the whole page: right of the title on desktop, in the back header on compact. */
  actions?: ReactNode;
  /** `wide` for pages that lay content out in a grid, such as a gallery. Defaults to a reading column. */
  width?: "default" | "wide";
  children: ReactNode;
}

/**
 * A full-width page with a centered content column. On desktop the title is a
 * document heading inside the page and the header only keeps the titlebar drag
 * region and window controls; on compact the title moves into a back header.
 */
export function PageLayout({
  title,
  onBack,
  testID,
  titleTestID,
  actions,
  width = "default",
  children,
}: PageLayoutProps) {
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const scrollContentStyle = useMemo(() => ({ paddingBottom: insets.bottom }), [insets.bottom]);
  const showTitle = !isCompact && title !== undefined;

  return (
    <View style={styles.container}>
      {isCompact ? (
        <BackHeader title={title} onBack={onBack} rightContent={actions} />
      ) : (
        <MenuHeader borderless />
      )}
      <PageScrollView
        // Leave room for field borders and padding around the focused native input.
        {...(Platform.OS === "android" ? { bottomOffset: SPACING[4] } : {})}
        style={styles.scroll}
        contentContainerStyle={scrollContentStyle}
        testID={testID}
      >
        <View style={width === "wide" ? styles.contentWide : styles.content}>
          {showTitle ? <PageTitle title={title} actions={actions} testID={titleTestID} /> : null}
          {children}
        </View>
      </PageScrollView>
    </View>
  );
}

/** The page that holds this one. Its name is the first part of the title and goes back to it. */
export interface PageTitleParent {
  label: string;
  /** What the press does, such as "Back to providers". */
  accessibilityLabel: string;
  onPress: () => void;
  testID?: string;
}

interface PageTitleProps {
  parent?: PageTitleParent;
  /** Drawn before the title, such as the icon of the thing the page is about. */
  icon?: ReactNode;
  title?: string;
  /** A control that belongs to the title, drawn right after it. */
  adornment?: ReactNode;
  /** Controls for the whole page, drawn at the trailing edge. */
  actions?: ReactNode;
  testID?: string;
  titleTestID?: string;
}

/**
 * The heading of a desktop page. A page that opens from another page, such as one provider from
 * Providers, names that page first: "Providers > Antigravity".
 */
export function PageTitle({
  parent,
  icon,
  title,
  adornment,
  actions,
  testID,
  titleTestID = "page-title",
}: PageTitleProps) {
  return (
    <View style={styles.titleRow} testID={testID}>
      <View style={styles.titleParts}>
        {parent ? (
          <PressHighlight
            accessibilityRole="button"
            accessibilityLabel={parent.accessibilityLabel}
            onPress={parent.onPress}
            testID={parent.testID}
          >
            {({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => (
              <Text style={[styles.title, styles.parent, hovered && styles.parentHovered]}>
                {parent.label}
              </Text>
            )}
          </PressHighlight>
        ) : null}
        {parent && title !== undefined ? (
          <ThemedChevronRight size={ICON_SIZE.lg} uniProps={separatorColor} />
        ) : null}
        {icon}
        {title !== undefined ? (
          <Text style={[styles.title, styles.titleLeaf]} numberOfLines={1} testID={titleTestID}>
            {title}
          </Text>
        ) : null}
        {adornment}
      </View>
      {actions}
    </View>
  );
}

const ThemedChevronRight = withUnistyles(ChevronRight);
const separatorColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: theme.spacing[4],
    paddingTop: theme.spacing[6],
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
  },
  contentWide: {
    padding: theme.spacing[4],
    paddingTop: theme.spacing[6],
    width: "100%",
    maxWidth: 1080,
    alignSelf: "center",
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[4],
    marginBottom: theme.spacing[6],
  },
  titleParts: {
    // Line up with the section titles, which sit inset from their cards.
    marginLeft: theme.spacing[1],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
    minWidth: 0,
  },
  title: {
    fontSize: theme.fontSize["4xl"],
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  titleLeaf: {
    flexShrink: 1,
  },
  parent: {
    color: theme.colors.foregroundMuted,
  },
  parentHovered: {
    color: theme.colors.foreground,
  },
}));
