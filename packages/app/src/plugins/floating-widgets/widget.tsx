import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Grip, Maximize2, Minus, Server, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useBlockMobilePanelOpenGestures } from "@/mobile-panels/provider";
import type { PluginFloatingWidgetProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import type { Theme } from "@/styles/theme";
import { PluginInstallationProvider } from "../installation-provider";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import {
  FloatingWidgetDragContext,
  FloatingWidgetDragHandle,
  useFloatingWidgetDragTarget,
} from "./drag-handle";
import {
  clampWidgetPosition,
  initialWidgetPosition,
  type FloatingWidgetTarget,
  type WidgetBounds,
  type WidgetPoint,
} from "./model";

const ThemedGrip = withUnistyles(Grip);
const ThemedMaximize = withUnistyles(Maximize2);
const ThemedMinus = withUnistyles(Minus);
const ThemedServer = withUnistyles(Server);
const ThemedX = withUnistyles(X);
const pluginThemeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });
const TOOLBAR_HEIGHT = 40;

export interface FloatingWidgetViewProps {
  target: FloatingWidgetTarget;
  host: PluginFloatingWidgetProps["host"];
  layout: PluginFloatingWidgetProps["layout"];
  bounds: WidgetBounds;
  onNextHost?: () => void;
  moveRevision?: number;
}

function WidgetContent({
  target,
  theme,
  ...props
}: Pick<FloatingWidgetViewProps, "target"> & PluginFloatingWidgetProps & { theme: PluginTheme }) {
  const Content = target.widget.contribution.Component;
  return (
    <PluginInstallationProvider plugin={target.plugin}>
      <Content {...props} theme={theme} />
    </PluginInstallationProvider>
  );
}

const ThemedWidgetContent = withUnistyles(WidgetContent);

/** The toolbar owns drag gestures; plugin content keeps its own taps and scroll gestures. */
export function FloatingWidgetView({
  target,
  host,
  layout,
  bounds,
  onNextHost,
  moveRevision = 0,
}: FloatingWidgetViewProps) {
  const { widget, plugin } = target;
  const { t } = useTranslation();
  const { contribution } = widget;
  const title = plugin.i18n.resolve(contribution.title, plugin.locale);
  const [collapsed, setCollapsed] = useState(false);
  const [dragging, setDragging] = useState(false);
  useBlockMobilePanelOpenGestures(dragging && widget.visible);
  const [position, setPosition] = useState<WidgetPoint | null>(null);
  const cornerIndex = useRef(0);
  const toolbar = contribution.chrome !== "none";
  const toolbarHeight = toolbar ? TOOLBAR_HEIGHT : 0;
  const requestedSize = contribution.size ?? { width: 160, height: 160 };
  const contentSize = useMemo(
    () => ({
      width: Math.min(requestedSize.width, bounds.width),
      height: Math.min(requestedSize.height, Math.max(0, bounds.height - toolbarHeight)),
    }),
    [bounds.height, bounds.width, requestedSize.height, requestedSize.width, toolbarHeight],
  );
  const frameSize = {
    width: Math.min(Math.max(contentSize.width, toolbar ? 208 : 0), bounds.width),
    height: toolbarHeight + (collapsed ? 0 : contentSize.height),
  };
  const resolvedPosition = position
    ? clampWidgetPosition(position, frameSize, bounds)
    : initialWidgetPosition(contribution.initialPosition ?? "bottom-right", frameSize, bounds);
  const geometry = useRef({ position: resolvedPosition, size: frameSize, bounds });
  useEffect(() => {
    geometry.current = { position: resolvedPosition, size: frameSize, bounds };
  });
  const moveToNextCorner = useCallback(() => {
    const corners = ["top-left", "top-right", "bottom-right", "bottom-left"] as const;
    setPosition(
      initialWidgetPosition(
        corners[cornerIndex.current % corners.length]!,
        geometry.current.size,
        geometry.current.bounds,
      ),
    );
    cornerIndex.current += 1;
  }, []);
  const dragStart = useRef<WidgetPoint>({ x: 0, y: 0 });
  const drag = useMemo(
    () => ({
      begin: () => {
        if (!widget.visible) return;
        dragStart.current = geometry.current.position;
        setDragging(true);
      },
      move: (dx: number, dy: number) => {
        if (!widget.visible) return;
        setPosition(
          clampWidgetPosition(
            { x: dragStart.current.x + dx, y: dragStart.current.y + dy },
            geometry.current.size,
            geometry.current.bounds,
          ),
        );
      },
      end: () => setDragging(false),
    }),
    [widget],
  );
  const toolbarDrag = useFloatingWidgetDragTarget(drag, { onPress: moveToNextCorner });

  useEffect(() => {
    setCollapsed(false);
    setDragging(false);
  }, [widget, widget.revealRevision]);
  useEffect(() => {
    if (moveRevision > 0) moveToNextCorner();
  }, [moveRevision, moveToNextCorner]);
  const collapse = useCallback(() => {
    if (toolbar) setCollapsed(true);
    else widget.hide();
  }, [toolbar, widget]);
  const toggleCollapsed = useCallback(() => setCollapsed((value) => !value), []);

  if (!widget.visible || bounds.width <= 0 || bounds.height <= 0 || bounds.height < toolbarHeight)
    return null;

  return (
    <View
      pointerEvents="box-none"
      testID={`plugin-floating-widget:${plugin.id}:${contribution.id}`}
      style={[
        styles.frame,
        { left: resolvedPosition.x, top: resolvedPosition.y, width: frameSize.width },
      ]}
    >
      {toolbar ? (
        <View style={styles.toolbar}>
          <View style={styles.dragHandle} {...toolbarDrag.panHandlers}>
            <ToolbarButton
              compact={layout.compact}
              label={t("floatingWidgets.move", { title })}
              tooltip={t("floatingWidgets.drag", { title })}
              onPress={toolbarDrag.activate}
            >
              <ThemedGrip size={16} uniProps={mutedIconColorMapping} />
            </ToolbarButton>
            <View style={styles.labels} pointerEvents="none">
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              <Text style={styles.source} numberOfLines={1}>
                {host.label}
              </Text>
            </View>
          </View>
          {onNextHost ? (
            <ToolbarButton
              compact={layout.compact}
              label={t("floatingWidgets.switchHost", { title, host: host.label })}
              onPress={onNextHost}
            >
              <ThemedServer size={16} uniProps={mutedIconColorMapping} />
            </ToolbarButton>
          ) : null}
          <ToolbarButton
            compact={layout.compact}
            label={t(collapsed ? "floatingWidgets.expand" : "floatingWidgets.collapse", { title })}
            onPress={toggleCollapsed}
          >
            {collapsed ? (
              <ThemedMaximize size={16} uniProps={mutedIconColorMapping} />
            ) : (
              <ThemedMinus size={16} uniProps={mutedIconColorMapping} />
            )}
          </ToolbarButton>
          <ToolbarButton
            compact={layout.compact}
            label={t("floatingWidgets.hide", { title })}
            onPress={widget.hide}
          >
            <ThemedX size={16} uniProps={mutedIconColorMapping} />
          </ToolbarButton>
        </View>
      ) : null}
      {!collapsed ? (
        <View style={[styles.content, contentSize]} pointerEvents="box-none">
          <SurfaceErrorBoundary
            installation={plugin.lifetime}
            Surface={contribution.Component}
            resetKey={widget.revealRevision}
          >
            <FloatingWidgetDragContext.Provider value={drag}>
              <ThemedWidgetContent
                target={target}
                host={host}
                layout={layout}
                size={contentSize}
                DragHandle={FloatingWidgetDragHandle}
                hide={widget.hide}
                collapse={collapse}
                uniProps={pluginThemeMapping}
              />
            </FloatingWidgetDragContext.Provider>
          </SurfaceErrorBoundary>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: { position: "absolute", alignItems: "center" },
  toolbar: {
    height: TOOLBAR_HEIGHT,
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[1],
    gap: theme.spacing[1],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
  },
  dragHandle: { flex: 1, flexDirection: "row", alignItems: "center", minWidth: 0 },
  labels: { flex: 1, minWidth: 0 },
  title: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  source: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  content: { overflow: "hidden" },
}));
