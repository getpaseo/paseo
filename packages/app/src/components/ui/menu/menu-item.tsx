import {
  useCallback,
  useMemo,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Pressable,
  Text,
  View,
  type PressableStateCallbackType,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, CheckCircle } from "lucide-react-native";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Theme } from "@/styles/theme";
import { MenuDepthProvider, useMenuContext } from "./menu-context";

const ThemedCheck = withUnistyles(Check);
const ThemedCheckCircle = withUnistyles(CheckCircle);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successMapping = (theme: Theme) => ({ color: theme.colors.palette.green[500] });

/**
 * Height of the filled part of a row, which is also its hit target.
 *
 * A pointer aims; a thumb lands, so the row is sized by what is driving it. The split is on
 * breakpoint rather than on `presentation`, because the compact popover — what `compactMode`
 * defaults to — is worked with a thumb just as a sheet is, and would keep the desktop height if
 * the sheet were the thing being asked about. `md` is where `useIsCompactFormFactor` divides, so
 * this and the popover/sheet choice always turn over together.
 *
 * On desktop the number is exactly the content: 18 line + 8 padding + 2 border. Leave the text's
 * `lineHeight` to the platform and the content outgrows `minHeight`, which then does nothing and
 * the rows drift taller again. On compact, `minHeight` leads instead and the label centres in it.
 */
const MENU_ITEM_HEIGHT = { xs: 40, md: 28 } as const;
const MENU_ITEM_LINE_HEIGHT = 18;

/**
 * Space between two rows, owned by the page rather than the rows. Zero because only one row is
 * ever filled at a time, so a gap here buys nothing on the common frame and only costs pitch.
 *
 * This is the knob a redesign turns. Note it applies to a page's direct children, so a group of
 * rows wrapped in a `View` of its own would not receive it — at zero there is nothing to lose,
 * but anything above it wants the wrapper to carry the same style.
 */
const MENU_ROW_GAP = 0;

/** Action status for menu items with loading/success feedback. */
export type ActionStatus = "idle" | "pending" | "success";

/**
 * One page of rows — the root surface, a flyout, or a pushed sheet page.
 *
 * It owns the vertical spacing of the menu: the inset above the first row and below the last,
 * and the gap between rows. A row knows how to draw its own fill and nothing about where it sits
 * in a list, so a redesign retunes the rhythm here and never touches `MenuItem`.
 *
 * Horizontal inset stays on the row. There is one left edge and one right edge, so a row's
 * horizontal margin is not standing in for anything else, and leaving it there keeps labels,
 * hints and the custom headers callers render into a surface aligned on the same 12pt.
 *
 * It also carries the page's depth, so the two presentations cannot disagree about what a page is.
 */
export function MenuPage({ depth, children }: PropsWithChildren<{ depth: number }>): ReactElement {
  return (
    <MenuDepthProvider value={depth}>
      <View style={styles.page}>{children}</View>
    </MenuDepthProvider>
  );
}

export function MenuLabel({
  children,
  style,
  testID,
}: PropsWithChildren<{ style?: ViewStyle | ViewStyle[]; testID?: string }>): ReactElement {
  const labelContainerStyle = useMemo(() => [styles.labelContainer, style], [style]);
  return (
    <View style={labelContainerStyle} testID={testID}>
      <Text style={styles.labelText}>{children}</Text>
    </View>
  );
}

export function MenuSeparator({
  style,
  testID,
}: {
  style?: ViewStyle;
  testID?: string;
}): ReactElement {
  const separatorStyle = useMemo(() => [styles.separator, style], [style]);
  return <View style={separatorStyle} testID={testID} />;
}

export function MenuHint({
  children,
  style,
  testID,
}: PropsWithChildren<{ style?: ViewStyle | ViewStyle[]; testID?: string }>): ReactElement {
  const hintContainerStyle = useMemo(() => [styles.hintContainer, style], [style]);
  return (
    <View style={hintContainerStyle} testID={testID}>
      <Text style={styles.hintText}>{children}</Text>
    </View>
  );
}

function resolveLeadingContent(input: {
  isPending: boolean | undefined;
  isSuccess: boolean;
  leading: ReactElement | null;
}): ReactElement | null {
  const { isPending, isSuccess, leading } = input;
  if (isPending) {
    return <ThemedLoadingSpinner size={16} uniProps={mutedMapping} />;
  }
  if (isSuccess) {
    return <ThemedCheckCircle size={16} uniProps={successMapping} />;
  }
  return leading;
}

function resolveItemLabel(input: {
  children: ReactNode;
  isPending: boolean | undefined;
  isSuccess: boolean;
  pendingLabel?: string;
  successLabel?: string;
}): ReactNode {
  const { children, isPending, isSuccess, pendingLabel, successLabel } = input;
  if (isPending && pendingLabel) return pendingLabel;
  if (isSuccess && successLabel) return successLabel;
  return children;
}

export interface MenuItemProps {
  description?: string;
  onSelect?: () => void;
  disabled?: boolean;
  muted?: boolean;
  destructive?: boolean;
  /**
   * This row's value is the chosen one. Draws a check and nothing else — a checked row that is
   * also filled in reads as two different claims about the same state.
   */
  selected?: boolean;
  /** Reserves a leading check column so a group of items stays aligned whether ticked or not. */
  showSelectedCheck?: boolean;
  /**
   * This row's submenu is open. Distinct from `selected`: it is about where you are, not what
   * you picked, so it takes the background that `selected` gives up.
   */
  active?: boolean;
  leading?: ReactElement | null;
  trailing?: ReactElement | null;
  /** @deprecated Use `status` instead */
  loading?: boolean;
  status?: ActionStatus;
  /** Label to show while pending (e.g. "Pushing…") */
  pendingLabel?: string;
  /** Label to show on success (e.g. "Pushed") */
  successLabel?: string;
  closeOnSelect?: boolean;
  testID?: string;
  tooltip?: string;
}

export function MenuItem({
  children,
  description,
  onSelect,
  disabled,
  muted = false,
  destructive,
  selected,
  showSelectedCheck = false,
  active = false,
  leading,
  trailing,
  loading,
  status,
  pendingLabel,
  successLabel,
  closeOnSelect = true,
  testID,
  tooltip,
}: PropsWithChildren<MenuItemProps>): ReactElement {
  const { selectItem } = useMenuContext("MenuItem");

  const isPending = status === "pending" || loading;
  const isSuccess = status === "success";
  const isDisabled = disabled || isPending || isSuccess;

  const leadingContent = resolveLeadingContent({
    isPending,
    isSuccess,
    leading: leading ?? null,
  });

  const label = resolveItemLabel({ children, isPending, isSuccess, pendingLabel, successLabel });

  const trailingContent =
    trailing ??
    (!showSelectedCheck && selected ? <ThemedCheck size={16} uniProps={mutedMapping} /> : null);

  const handleItemPress = useCallback(() => {
    if (isDisabled) return;
    selectItem(onSelect, closeOnSelect);
  }, [isDisabled, selectItem, onSelect, closeOnSelect]);

  const itemPressableStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.item,
      active ? styles.itemActive : null,
      isDisabled ? styles.itemDisabled : null,
      muted && !isDisabled ? styles.itemMuted : null,
      hovered && !pressed && !isDisabled ? styles.itemHovered : null,
      pressed && !isDisabled ? styles.itemPressed : null,
    ],
    [active, isDisabled, muted],
  );

  const itemTextStyle = useMemo(
    () => [
      styles.itemText,
      destructive && !isSuccess ? styles.itemTextDestructive : null,
      isSuccess ? styles.itemTextSuccess : null,
      muted && !isDisabled ? styles.itemTextMuted : null,
    ],
    [destructive, isSuccess, muted, isDisabled],
  );

  const content = (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      disabled={isDisabled}
      onPress={handleItemPress}
      style={itemPressableStyle}
    >
      {showSelectedCheck ? (
        <View style={styles.checkSlot}>
          {selected ? <ThemedCheck size={16} uniProps={foregroundMapping} /> : null}
        </View>
      ) : null}
      {leadingContent ? <View style={styles.leadingSlot}>{leadingContent}</View> : null}
      <View style={styles.itemContent}>
        <Text numberOfLines={1} style={itemTextStyle}>
          {label}
        </Text>
        {description && !isPending && !isSuccess ? (
          <Text numberOfLines={2} style={styles.itemDescription}>
            {description}
          </Text>
        ) : null}
      </View>
      {trailingContent ? <View style={styles.trailingSlot}>{trailingContent}</View> : null}
    </Pressable>
  );

  if (!tooltip) {
    return content;
  }

  return (
    <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent side="right" align="center" offset={10}>
        <Text style={styles.tooltipText}>{tooltip}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    paddingVertical: theme.spacing[1],
    gap: MENU_ROW_GAP,
  },
  labelContainer: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  labelText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  // `border` sits between surface1 and surface2, which put it within a hair of the hover fill and
  // made separators vanish against a hovered row. `borderAccent` is the colour the menu surface
  // already outlines itself with, so the divider reads as part of the same frame.
  //
  // The one thing on a page that wants more room than the row gap gives it, so it says so here.
  // That is one number controlling one gap: rows no longer carry vertical spacing of their own,
  // so there is nothing left for this to double up with.
  //
  // No horizontal margin, and the page has no horizontal padding, so the rule still runs the
  // full width of the surface rather than reading as an inset tick between two chips.
  separator: {
    height: 1,
    marginVertical: theme.spacing[1],
    backgroundColor: theme.colors.borderAccent,
  },
  hintContainer: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  hintText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  // The fill is inset from the surface's edges and rounded, so a hovered row reads as a chip
  // sitting inside the menu rather than a band across it.
  //
  // The inset is taken out of the row, not added to it: margin 4 + padding 8 + border 1 lands the
  // label at the same 13pt it always sat at.
  //
  // Horizontal only. Vertical spacing — the inset above the first row and below the last, and the
  // gap between rows — belongs to `MenuPage`. A margin here would have to be both of those at
  // once, and since margins do not collapse it would land as one unit at the edges and two
  // between rows, so shrinking the gap would eat the inset with it.
  item: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: MENU_ITEM_HEIGHT,
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderWidth: theme.borderWidth[1],
    borderColor: "transparent",
    borderRadius: theme.borderRadius.md,
  },
  itemHovered: {
    backgroundColor: theme.colors.surface2,
  },
  itemPressed: {
    backgroundColor: theme.colors.surface2,
  },
  // The row you are inside, not the value you chose. A chosen value is marked by its check.
  itemActive: {
    backgroundColor: theme.colors.surface2,
  },
  itemDisabled: {
    opacity: 0.5,
  },
  itemMuted: {
    opacity: 0.72,
  },
  itemText: {
    fontSize: theme.fontSize.sm,
    lineHeight: MENU_ITEM_LINE_HEIGHT,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.normal,
  },
  itemTextMuted: {
    color: theme.colors.foregroundMuted,
  },
  itemTextDestructive: {
    color: theme.colors.destructive,
  },
  itemTextSuccess: {
    color: theme.colors.palette.green[500],
  },
  itemDescription: {
    marginTop: 2,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  checkSlot: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  leadingSlot: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  trailingSlot: {
    marginLeft: "auto",
    alignItems: "center",
    justifyContent: "center",
  },
  itemContent: {
    flexShrink: 1,
    minWidth: 0,
  },
}));
