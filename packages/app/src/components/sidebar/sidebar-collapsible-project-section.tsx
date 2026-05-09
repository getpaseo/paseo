import React, {
  forwardRef,
  memo,
  useCallback,
  useMemo,
  type ComponentType,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import {
  Pressable,
  View,
  type GestureResponderEvent,
  type PressableProps,
  type PressableStateCallbackType,
  type ViewProps,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import {
  SidebarProjectIcon,
  SidebarProjectRowVisual,
} from "@/components/sidebar/sidebar-project-row-visual";

export type SidebarProjectChevronDirection = "expand" | "collapse";

export interface SidebarProjectHeaderRowProps {
  projectName: string;
  iconDataUri: string | null;
  onPress: () => void;
  isHovered: boolean;

  /** Visual collapsed state. When set, drives the chevron direction (down=collapse / right=expand). */
  chevron?: SidebarProjectChevronDirection | null;

  selected?: boolean;
  isDragging?: boolean;

  /** Replaces the chevron+icon leading visual entirely (e.g. archiving spinner, workspace status icon). */
  leadingVisualOverride?: ReactElement | null;

  /** Appended after the project name. Kebab, new-worktree button, shortcut badge. */
  trailingSlot?: ReactNode;

  /** Long-press / drag handlers. */
  onPressIn?: (event: GestureResponderEvent) => void;
  onTouchMove?: (event: GestureResponderEvent) => void;
  onPressOut?: (event: GestureResponderEvent) => void;

  testID?: string;
  accessibilityLabel?: string;

  /** Substitute for the inner Pressable (e.g. ContextMenuTrigger). Receives the same props. */
  PressableComponent?: ComponentType<PressableProps & { ref?: Ref<View> }>;
}

export interface SidebarProjectSectionProps {
  projectKey: string;
  projectName: string;
  iconDataUri: string | null;
  onPress: () => void;
  isHovered: boolean;
  chevron: "expand" | "collapse" | null;
  selected?: boolean;
  isDragging?: boolean;
  trailingSlot?: ReactNode;
  testID?: string;
  children?: ReactNode;
  footer?: ReactNode;
  isCollapsed: boolean;
  headerProps?: Pick<
    SidebarProjectHeaderRowProps,
    | "accessibilityLabel"
    | "leadingVisualOverride"
    | "onPressIn"
    | "onTouchMove"
    | "onPressOut"
    | "PressableComponent"
  >;
}

export const SidebarProjectSection = memo(function SidebarProjectSection({
  projectName,
  iconDataUri,
  onPress,
  isHovered,
  chevron,
  selected = false,
  isDragging = false,
  trailingSlot = null,
  testID,
  children = null,
  footer = null,
  isCollapsed,
  headerProps,
}: SidebarProjectSectionProps): ReactElement {
  return (
    <>
      <SidebarProjectHeaderRow
        projectName={projectName}
        iconDataUri={iconDataUri}
        chevron={chevron}
        isHovered={isHovered}
        isDragging={isDragging}
        selected={selected}
        trailingSlot={trailingSlot}
        onPress={onPress}
        testID={testID}
        {...headerProps}
      />
      {!isCollapsed ? (
        <>
          {children}
          {footer}
        </>
      ) : null}
    </>
  );
});

/**
 * Shared chrome for a project row that names a section: pressable, hover/press/selected
 * styles, on-hover chevron leading visual, and a trailing actions slot.
 *
 * Hover is controlled — callers wrap with their own outer View carrying onPointerEnter/Leave
 * (workspace tree adds drag-handle attrs to that wrapper; sessions wraps a plain View).
 */
export const SidebarProjectHeaderRow = memo(
  forwardRef<View, SidebarProjectHeaderRowProps>(function SidebarProjectHeaderRow(
    {
      projectName,
      iconDataUri,
      onPress,
      isHovered,
      chevron = null,
      selected = false,
      isDragging = false,
      leadingVisualOverride = null,
      trailingSlot = null,
      onPressIn,
      onTouchMove,
      onPressOut,
      testID,
      accessibilityLabel,
      PressableComponent = Pressable,
    },
    ref,
  ): ReactElement {
    const showChevron = isHovered && chevron !== null;
    const leadingVisual = useMemo<ReactElement | null>(() => {
      if (showChevron && chevron) {
        return (
          <View style={sidebarProjectHeaderRowStyles.leadingSlot}>
            <SidebarProjectChevron chevron={chevron} />
          </View>
        );
      }
      if (leadingVisualOverride) {
        return leadingVisualOverride;
      }
      return <SidebarProjectIcon projectName={projectName} iconDataUri={iconDataUri} />;
    }, [chevron, iconDataUri, leadingVisualOverride, projectName, showChevron]);

    const pressableStyle = useCallback(
      ({ pressed }: PressableStateCallbackType) => [
        sidebarProjectHeaderRowStyles.row,
        isDragging && sidebarProjectHeaderRowStyles.dragging,
        selected && sidebarProjectHeaderRowStyles.selected,
        isHovered && sidebarProjectHeaderRowStyles.hovered,
        pressed && sidebarProjectHeaderRowStyles.pressed,
      ],
      [isDragging, isHovered, selected],
    );

    return (
      <PressableComponent
        ref={ref}
        style={pressableStyle}
        onPress={onPress}
        onPressIn={onPressIn}
        onTouchMove={onTouchMove}
        onPressOut={onPressOut}
        accessibilityLabel={accessibilityLabel}
        testID={testID}
      >
        <SidebarProjectRowVisual
          projectName={projectName}
          iconDataUri={iconDataUri}
          leadingVisual={leadingVisual}
        />
        {trailingSlot}
      </PressableComponent>
    );
  }),
);

function SidebarProjectChevron({
  chevron,
}: {
  chevron: SidebarProjectChevronDirection;
}): ReactElement {
  if (chevron === "collapse") {
    return <ChevronDown size={14} color="#9ca3af" />;
  }
  return <ChevronRight size={14} color="#9ca3af" />;
}

/**
 * Outer wrapper that carries hover state for a `<SidebarProjectHeaderRow>` plus extra props
 * (drag handle attrs, ref). Sessions uses the lighter `<SidebarProjectHeaderHoverWrap>`.
 */
export const SidebarProjectHeaderHoverWrap = forwardRef<
  View,
  ViewProps & {
    onHoverChange: (hovered: boolean) => void;
  }
>(function SidebarProjectHeaderHoverWrap({ onHoverChange, children, ...rest }, ref): ReactElement {
  const handleEnter = useCallback(() => onHoverChange(true), [onHoverChange]);
  const handleLeave = useCallback(() => onHoverChange(false), [onHoverChange]);
  return (
    <View ref={ref} {...rest} onPointerEnter={handleEnter} onPointerLeave={handleLeave}>
      {children}
    </View>
  );
});

export const sidebarProjectHeaderRowStyles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[1],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  hovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  pressed: {
    backgroundColor: theme.colors.surface2,
  },
  selected: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  dragging: {
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    transform: [{ scale: 1.02 }],
    zIndex: 3,
    ...theme.shadow.md,
  },
  leadingSlot: {
    position: "relative",
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
}));

/**
 * Indent style for rows nested under a `<SidebarProjectHeaderRow>`. Workspace rows and
 * grouped-session rows both apply this so children visually align across surfaces.
 */
export const sidebarProjectChildIndentStyles = StyleSheet.create((theme) => ({
  childRow: {
    paddingLeft: theme.spacing[3] + theme.spacing[3],
    paddingRight: theme.spacing[3],
  },
}));
