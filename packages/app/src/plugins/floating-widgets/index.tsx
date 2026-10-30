import { Portal, PortalHost } from "@gorhom/portal";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { View, StyleSheet, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCommandCenterActions } from "@/command-center/provider";
import type { CommandCenterContribution } from "@/command-center/contributions";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSettledKeyboardShift } from "@/keyboard/shift";
import { useHosts } from "@/runtime/host-runtime";
import { WindowChromeRootRegion, WindowChromeSafeArea } from "@/utils/desktop-window";
import { useInstalledPlugins } from "../registry";
import { resolvePluginPlatform } from "../platform";
import {
  floatingWidgetBounds,
  groupFloatingWidgets,
  selectFloatingWidgetTarget,
  type FloatingWidgetGroup,
  type WidgetBounds,
} from "./model";
import { FloatingWidgetView } from "./widget";

const PORTAL_HOST = "plugin-floating-widgets";

function FloatingWidgetGroupView({
  group,
  bounds,
}: {
  group: FloatingWidgetGroup;
  bounds: WidgetBounds;
}) {
  const [moveRevision, setMoveRevision] = useState(0);
  const [preferredHost, setPreferredHost] = useState<string | null>(null);
  const { t } = useTranslation();
  const target = selectFloatingWidgetTarget(group, preferredHost);
  const hosts = useHosts();
  const compact = useIsCompactFormFactor();
  const { plugin, widget } = target;
  const hostLabel =
    hosts.find((entry) => entry.serverId === plugin.serverId)?.label ?? plugin.serverId;
  const host = useMemo(
    () => ({ id: plugin.serverId, label: hostLabel }),
    [hostLabel, plugin.serverId],
  );
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const title = plugin.i18n.resolve(widget.contribution.title, plugin.locale);
  const nextHost = useCallback(() => {
    const index = group.targets.findIndex((entry) => entry.plugin.serverId === plugin.serverId);
    const next = group.targets[(index + 1) % group.targets.length]!;
    setPreferredHost(next.plugin.serverId);
    next.widget.show();
  }, [group.targets, plugin.serverId]);
  const move = useCallback(() => {
    widget.show();
    setMoveRevision((revision) => revision + 1);
  }, [widget]);
  const actions = useMemo<CommandCenterContribution[]>(() => {
    const entries = [
      { id: "show", title: t("floatingWidgets.show", { title }), run: widget.show },
      { id: "hide", title: t("floatingWidgets.hide", { title }), run: widget.hide },
      { id: "move", title: t("floatingWidgets.move", { title }), run: move },
    ];
    if (group.targets.length > 1)
      entries.push({
        id: "switch-host",
        title: t("floatingWidgets.switchHost", { title, host: host.label }),
        run: nextHost,
      });
    return entries.map((entry, rank) => ({
      id: `floating-widget:${group.key}:${entry.id}`,
      group: `plugin:${plugin.id}`,
      groupRank: 5,
      rank,
      keywords: ["floating", "widget", entry.id, plugin.id],
      visibility: "always",
      presentation: {
        kind: "action",
        title: entry.title,
        subtitle: host.label,
        sectionTitle: plugin.id,
      },
      run: entry.run,
    }));
  }, [group.key, group.targets.length, host.label, move, nextHost, plugin.id, t, title, widget]);
  useCommandCenterActions({ sourceId: `floating-widget:${group.key}`, enabled: true, actions });
  return (
    <FloatingWidgetView
      target={target}
      host={host}
      layout={layout}
      bounds={bounds}
      moveRevision={moveRevision}
      onNextHost={group.targets.length > 1 ? nextHost : undefined}
    />
  );
}

/** A root-lifetime layer below popovers, sheets, and modal focus scopes. */
export function PluginFloatingWidgets() {
  const installed = useInstalledPlugins();
  const groups = useMemo(() => groupFloatingWidgets(installed), [installed]);
  const insets = useSafeAreaInsets();
  const keyboardShift = useSettledKeyboardShift();
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewport((previous) =>
      previous.width === width && previous.height === height ? previous : { width, height },
    );
  }, []);
  const bounds = floatingWidgetBounds(viewport, insets, keyboardShift);
  return (
    <View pointerEvents="box-none" style={styles.layer}>
      <WindowChromeRootRegion corners="both">
        <WindowChromeSafeArea placement="below" pointerEvents="none" />
        <View pointerEvents="box-none" style={styles.viewport} onLayout={onLayout}>
          <PortalHost name={PORTAL_HOST} />
          <Portal hostName={PORTAL_HOST}>
            {groups.map((group) => (
              <FloatingWidgetGroupView key={group.key} group={group} bounds={bounds} />
            ))}
          </Portal>
        </View>
      </WindowChromeRootRegion>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { ...StyleSheet.absoluteFill },
  viewport: { flex: 1 },
});
