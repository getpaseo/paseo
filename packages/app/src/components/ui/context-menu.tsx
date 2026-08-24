import {
  useCallback,
  type ComponentProps,
  type PropsWithChildren,
  type ReactElement,
  type Ref,
} from "react";
import {
  Platform,
  StatusBar,
  View,
  type GestureResponderEvent,
  type PressableProps,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { isNative, isWeb } from "@/constants/platform";
import {
  MenuHint,
  MenuItem,
  MenuLabel,
  MenuRoot,
  MenuSeparator,
  MenuSurface,
  useMenuContext,
  type MenuSurfaceProps,
  type MenuTriggerState,
} from "@/components/ui/menu";
import { PressHighlight } from "@/components/ui/press-highlight";

/**
 * A menu opened by a long press or a right click, anchored to the point of the gesture rather
 * than to a trigger box.
 *
 * Everything below the trigger is the shared menu engine — see `@/components/ui/menu` and
 * docs/menus.md. Only the way it opens is different from `dropdown-menu.tsx`.
 */

export { MenuItem as ContextMenuItem };
export { MenuLabel as ContextMenuLabel };
export { MenuSeparator as ContextMenuSeparator };
export { MenuHint as ContextMenuHint };
export type { ActionStatus } from "@/components/ui/menu";

/**
 * Context menus use the mobile menu convention by default: long press opens a bottom sheet on a
 * compact layout, while right click opens an anchored popover on a wide layout.
 */
export function ContextMenu({
  compactMode = "sheet",
  ...props
}: ComponentProps<typeof MenuRoot>): ReactElement {
  return <MenuRoot {...props} compactMode={compactMode} />;
}

export function ContextMenuContent(props: MenuSurfaceProps): ReactElement | null {
  return <MenuSurface {...props} />;
}

export function useContextMenu() {
  return useMenuContext("useContextMenu");
}

function isCallable(fn: unknown): fn is (...args: unknown[]) => void {
  return typeof fn === "function";
}

function coerceEventPoint(event: unknown): { pageX: number; pageY: number } | null {
  if (typeof event !== "object" || event === null) return null;

  const nativeEvent = Reflect.get(event, "nativeEvent");
  const source = typeof nativeEvent === "object" && nativeEvent !== null ? nativeEvent : event;
  const pageX = Reflect.get(source, "pageX");
  const pageY = Reflect.get(source, "pageY");
  if (typeof pageX === "number" && typeof pageY === "number") {
    return { pageX, pageY };
  }

  const clientX = Reflect.get(source, "clientX");
  const clientY = Reflect.get(source, "clientY");
  if (typeof clientX === "number" && typeof clientY === "number") {
    return { pageX: clientX, pageY: clientY };
  }
  return null;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T): void {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  (ref as { current: T }).current = value;
}

type TriggerStyleProp = StyleProp<ViewStyle> | ((state: MenuTriggerState) => StyleProp<ViewStyle>);

export function ContextMenuTrigger({
  children,
  disabled,
  highlightStyle,
  style,
  enabled = true,
  enabledOnMobile = true,
  enabledOnWeb = true,
  longPressDelayMs,
  onContextMenu,
  triggerRef,
  ...props
}: PropsWithChildren<
  Omit<PressableProps, "style"> & {
    highlightStyle?: StyleProp<ViewStyle>;
    style?: TriggerStyleProp;
    enabled?: boolean;
    enabledOnMobile?: boolean;
    enabledOnWeb?: boolean;
    longPressDelayMs?: number;
    onContextMenu?: (event: unknown) => void;
    triggerRef?: Ref<View | null>;
  }
>): ReactElement {
  const ctx = useMenuContext("ContextMenuTrigger");

  const shouldEnableOnThisPlatform = enabled && (isWeb ? enabledOnWeb : enabledOnMobile);

  const openAtEvent = useCallback(
    (event: unknown) => {
      if (!shouldEnableOnThisPlatform || disabled) return;
      const point = coerceEventPoint(event);
      if (!point) return;

      const statusBarHeight = Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;
      ctx.setAnchorRect({
        x: point.pageX,
        y: point.pageY + statusBarHeight,
        width: 0,
        height: 0,
      });
      ctx.setOpen(true);
    },
    [ctx, disabled, shouldEnableOnThisPlatform],
  );

  const handleRef = useCallback(
    (node: View | null) => {
      assignRef(ctx.triggerRef, node);
      assignRef(triggerRef, node);
    },
    [ctx.triggerRef, triggerRef],
  );

  const propsOnLongPress = props.onLongPress;
  const handleLongPress = useCallback(
    (event: GestureResponderEvent) => {
      if (isWeb) {
        propsOnLongPress?.(event);
        return;
      }
      openAtEvent(event);
      propsOnLongPress?.(event);
    },
    [propsOnLongPress, openAtEvent],
  );

  const handleContextMenu = useCallback(
    (event: unknown) => {
      if (isNative) return;
      if (typeof event === "object" && event !== null) {
        const preventDefault = Reflect.get(event, "preventDefault");
        const stopPropagation = Reflect.get(event, "stopPropagation");
        if (isCallable(preventDefault)) preventDefault.call(event);
        if (isCallable(stopPropagation)) stopPropagation.call(event);
      }
      onContextMenu?.(event);
      openAtEvent(event);
    },
    [onContextMenu, openAtEvent],
  );

  const resolveDynamicStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => {
      if (typeof style === "function") {
        return style({ pressed, hovered, open: ctx.open });
      }
      return style;
    },
    [style, ctx.open],
  );

  return (
    <PressHighlight
      {...props}
      ref={handleRef}
      collapsable={false}
      disabled={disabled}
      delayLongPress={longPressDelayMs}
      onLongPress={handleLongPress}
      // @ts-ignore - onContextMenu is web-only and not in RN types.
      onContextMenu={handleContextMenu}
      style={typeof style === "function" ? resolveDynamicStyle : style}
      highlightStyle={highlightStyle}
    >
      {children}
    </PressHighlight>
  );
}
