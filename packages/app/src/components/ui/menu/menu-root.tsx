import {
  forwardRef,
  useCallback,
  useMemo,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import {
  Pressable,
  type View,
  type PressableProps,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  MenuContextProvider,
  useMenuContext,
  useMenuState,
  type MenuCompactMode,
} from "./menu-context";
import { usePressDragSelect } from "../use-press-drag-select";
import { PressDragSelectionContext } from "../press-drag-select-context";
import { isWeb } from "@/constants/platform";

/**
 * Owns one menu's state. Wrap a trigger and a `MenuSurface` in it.
 *
 * The trigger is deliberately not part of this: what opens a menu is the only thing that
 * differs between a dropdown (press) and a context menu (long press or right click), and it is
 * the whole reason those two wrappers still exist.
 */
export function MenuRoot({
  open,
  defaultOpen,
  onOpenChange,
  compactMode,
  pressDrag = true,
  children,
}: PropsWithChildren<{
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  compactMode?: MenuCompactMode;
  /** Context-menu triggers own their gestures. */
  pressDrag?: boolean;
}>): ReactElement {
  const value = useMenuState({ open, defaultOpen, onOpenChange, compactMode });
  const selection = usePressDragSelect({
    anchorRef: value.triggerRef,
    open: value.open,
    onOpenChange: value.setOpen,
    enabled: pressDrag && value.presentation === "popover",
  });
  return (
    <PressDragSelectionContext value={selection}>
      <MenuContextProvider value={value}>{children}</MenuContextProvider>
    </PressDragSelectionContext>
  );
}

export interface MenuTriggerState {
  pressed: boolean;
  hovered: boolean;
  open: boolean;
}

type TriggerStyleProp = StyleProp<ViewStyle> | ((state: MenuTriggerState) => StyleProp<ViewStyle>);

export interface MenuTriggerProps extends Omit<PressableProps, "style" | "children"> {
  style?: TriggerStyleProp;
  children: ReactNode | ((state: MenuTriggerState) => ReactNode);
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  Object.assign(ref, { current: value });
}

export const MenuTrigger = forwardRef<View, MenuTriggerProps>(function MenuTrigger(
  { children, disabled, style, accessibilityState, ...props },
  forwardedRef,
): ReactElement {
  const ctx = useMenuContext("MenuTrigger");

  const handleTriggerRef = useCallback(
    (node: View | null) => {
      assignRef(ctx.triggerRef, node);
      assignRef(forwardedRef, node);
    },
    [ctx.triggerRef, forwardedRef],
  );

  const handlePress = useCallback(() => {
    if (disabled) return;
    ctx.setOpen(!ctx.open);
  }, [disabled, ctx]);

  const pressableStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => {
      if (typeof style === "function") {
        return style({ pressed, hovered, open: ctx.open });
      }
      return style;
    },
    [style, ctx.open],
  );

  const renderChildren = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => {
      const state: MenuTriggerState = { pressed, hovered, open: ctx.open };
      return typeof children === "function" ? children(state) : children;
    },
    [children, ctx.open],
  );
  const resolvedAccessibilityState = useMemo(
    () => ({ ...accessibilityState, disabled: Boolean(disabled), expanded: ctx.open }),
    [accessibilityState, ctx.open, disabled],
  );
  const webExpandedState = useMemo(
    () => (isWeb ? ({ "aria-expanded": ctx.open } as const) : null),
    [ctx.open],
  );

  return (
    <Pressable
      {...props}
      {...webExpandedState}
      ref={handleTriggerRef}
      collapsable={false}
      disabled={disabled}
      accessibilityState={resolvedAccessibilityState}
      onPress={handlePress}
      style={pressableStyle}
    >
      {renderChildren}
    </Pressable>
  );
});
