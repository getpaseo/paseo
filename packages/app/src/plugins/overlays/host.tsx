import type { PluginTheme } from "@getpaseo/plugin";
import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { createPluginClientStateSource } from "../client-state/source";
import { usePluginHostNavigation } from "../host-navigation";
import { usePluginLayout } from "../layout";
import { useInstalledPlugin } from "../registry";
import { PluginRuntimeBoundary } from "../runtime-boundary";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import { pluginOverlayStore, type PluginOverlayEntry } from "./store";

const pluginThemeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

/** A failed overlay has no surface to explain itself in, so it closes and says why. */
function OverlayFailed({ error, close }: { error: string; close: () => void }) {
  const toast = useToast();
  useEffect(() => {
    toast.error(`Plugin failed: ${error}`);
    close();
  }, [close, error, toast]);
  return null;
}

function DetachedOverlay({ entry, theme }: { entry: PluginOverlayEntry; theme: PluginTheme }) {
  const { serverId, pluginId, Component, close } = entry;
  const plugin = useInstalledPlugin(serverId, pluginId);
  // The component belongs to the bundle that opened it. A reload, disable, or removal replaces or
  // drops that installation, and the overlay goes with it.
  const [openedBy] = useState(plugin);
  const isStale = !plugin || plugin !== openedBy;
  const client = useHostRuntimeClient(serverId);
  const hosts = useHosts();
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const host = useMemo(() => ({ id: serverId, label: hostLabel }), [hostLabel, serverId]);
  const layout = usePluginLayout(useIsCompactFormFactor());
  const navigation = usePluginHostNavigation(serverId, pluginId);
  const state = useMemo(() => createPluginClientStateSource(serverId), [serverId]);
  const renderError = useCallback(
    (error: string) => <OverlayFailed error={error} close={close} />,
    [close],
  );

  useEffect(() => {
    if (isStale) close();
  }, [close, isStale]);

  if (isStale || !client) return null;
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Component} renderError={renderError}>
      <PluginRuntimeBoundary plugin={plugin} client={client}>
        <PluginClientStateProvider source={state}>
          <Component
            theme={theme}
            host={host}
            layout={layout}
            navigation={navigation}
            close={close}
          />
        </PluginClientStateProvider>
      </PluginRuntimeBoundary>
    </SurfaceErrorBoundary>
  );
}

const ThemedDetachedOverlay = withUnistyles(DetachedOverlay);

/**
 * Mounts overlays opened with `openOverlay`. Each renders its own `Overlay`, which escapes this
 * position in the tree, so the host can sit anywhere under the app's providers.
 */
export function PluginOverlayHost() {
  const entries = useSyncExternalStore(
    pluginOverlayStore.subscribe,
    pluginOverlayStore.getSnapshot,
    pluginOverlayStore.getSnapshot,
  );
  return entries.map((entry) => (
    <ThemedDetachedOverlay key={entry.key} entry={entry} uniProps={pluginThemeMapping} />
  ));
}
