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
import { withContentDrag } from "@/components/ui/content-drag";
import { useIsCompactFormFactor } from "@/constants/layout";
import { ICON_SIZE, SPACING, type Theme } from "@/styles/theme";

// Rows on a page drag to reorder, so the page stops scrolling while a drag holds the touch.
const PageScrollView =
  Platform.OS === "android"
    ? withContentDrag(KeyboardAwareScrollView)
    : withContentDrag(ScrollView);

interface PageLayoutProps {
  title?: string;
  /** Short page description shown below the title on desktop and above the body on compact. */
  description?: string;
  /** Compact back button. Defaults to navigating back. */
  onBack?: () => void;
  testID?: string;
  titleTestID?: string;
  descriptionTestID?: string;
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
  description,
  onBack,
  testID,
  titleTestID,
  descriptionTestID,
  actions,
  width = "default",
  children,
}: PageLayoutProps) {
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const scrollContentStyle = useMemo(() => ({ paddingBottom: insets.bottom }), [insets.bottom]);
  const showTitle = !isCompact && title !== undefined;
  let pageHeader: ReactNode = null;
  if (showTitle) {
    pageHeader = (
      <PageTitle
        title={title}
        description={description}
        actions={actions}
        testID={titleTestID}
        descriptionTestID={descriptionTestID}
      />
    );
  } else if (description) {
    pageHeader = (
      <Text style={styles.compactDescription} testID={descriptionTestID}>
        {description}
      </Text>
    );
  }

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
          {pageHeader}
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
  /** Short page description rendered directly below the title on the same leading rail. */
  description?: string;
  /** A control that belongs to the title, drawn right after it. */
  adornment?: ReactNode;
  /** Controls for the whole page, drawn at the trailing edge. */
  actions?: ReactNode;
  testID?: string;
  titleTestID?: string;
  descriptionTestID?: string;
}

/**
 * The heading of a desktop page. A page that opens from another page, such as one provider from
 * Providers, names that page first: "Providers > Antigravity".
 */
export function PageTitle({
  parent,
  icon,
  title,
  description,
  adornment,
  actions,
  testID,
  titleTestID = "page-title",
  descriptionTestID,
}: PageTitleProps) {
  return (
    <View style={styles.titleBlock} testID={testID}>
      <View style={styles.titleRow}>
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
      {description ? (
        <Text style={styles.description} testID={descriptionTestID}>
          {description}
        </Text>
      ) : null}
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
  titleBlock: {
    marginBottom: theme.spacing[6],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[4],
  },
  description: {
    marginLeft: theme.spacing[1],
    marginTop: theme.spacing[1.5],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.45),
  },
  compactDescription: {
    marginBottom: theme.spacing[4],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.45),
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
