import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type PropsWithChildren,
  type ReactElement,
} from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { useMenuContext, useMenuDepth } from "./menu-context";
import { isSubPageOpen } from "./menu-navigation";
import { useMenuSurface } from "./menu-surface";
import { MenuItem } from "./menu-item";

const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * A row that leads to a submenu page, showing the decision's current value on the way in
 * ("Grouping  Project ›"). Selecting it navigates rather than acting, so it never closes the
 * menu.
 *
 * Hover lives on a plain `View` wrapping the item's `Pressable`, per docs/hover.md — a
 * `Pressable` tracking its own hover would fight the one inside it. Hover only fires on web,
 * which is exactly where flyouts exist; every other platform opens the page by pressing.
 */
export function MenuSubTrigger({
  id,
  value,
  indicator = false,
  disabled,
  testID,
  children,
}: PropsWithChildren<{
  /** Matches the `id` of a `MenuPageDefinition` passed to the surface. */
  id: string;
  /** Current value of the decision this row leads to. */
  value?: string;
  /** Marks the branch as holding a non-default setting, e.g. an active filter. */
  indicator?: boolean;
  disabled?: boolean;
  testID?: string;
}>): ReactElement {
  const menu = useMenuContext("MenuSubTrigger");
  const depth = useMenuDepth();
  const { registerSubAnchor, hoverOpen, hoverClose, cancelHoverClose } =
    useMenuSurface("MenuSubTrigger");
  const anchorRef = useRef<View>(null);

  useEffect(() => {
    registerSubAnchor(id, anchorRef);
  }, [id, registerSubAnchor]);

  const isOpen = isSubPageOpen(menu.path, { id, depth });
  const isPopover = menu.presentation === "popover";

  const handleSelect = useCallback(() => {
    menu.openSub({ id, depth });
  }, [menu, id, depth]);

  const handlePointerEnter = useCallback(() => {
    cancelHoverClose();
    hoverOpen({ id, depth });
  }, [cancelHoverClose, hoverOpen, id, depth]);

  const handlePointerLeave = useCallback(() => {
    hoverClose(depth);
  }, [hoverClose, depth]);

  const trailing = useMemo(
    () => <MenuSubTrailing value={value} indicator={indicator} />,
    [value, indicator],
  );

  return (
    <View
      ref={anchorRef}
      collapsable={false}
      onPointerEnter={isPopover && !disabled ? handlePointerEnter : undefined}
      onPointerLeave={isPopover && !disabled ? handlePointerLeave : undefined}
    >
      <MenuItem
        active={isOpen}
        closeOnSelect={false}
        disabled={disabled}
        onSelect={handleSelect}
        trailing={trailing}
        testID={testID}
      >
        {children}
      </MenuItem>
    </View>
  );
}

function MenuSubTrailing({
  value,
  indicator,
}: {
  value?: string;
  indicator: boolean;
}): ReactElement {
  return (
    <View style={styles.trailing}>
      {value ? (
        <Text style={styles.valueText} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {indicator ? <View style={styles.indicator} testID="menu-sub-indicator" /> : null}
      <ThemedChevronRight size={14} uniProps={mutedIconMapping} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  valueText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  indicator: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
}));
