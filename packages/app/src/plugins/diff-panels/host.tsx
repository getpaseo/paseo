import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginDiffPanelParams, PluginTab } from "@getpaseo/plugin/client";
import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { defaultChangesState } from "@/panels/changes/state";
import { usePaneContext } from "@/panels/pane-context";
import { usePublishPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { createPluginClientStateSource } from "../client-state/source";
import { usePluginHostNavigation } from "../host-navigation";
import { PluginInstallationProvider } from "../installation-provider";
import { resolvePluginPlatform } from "../platform";
import { useInstalledPlugins } from "../registry";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import {
  readPluginDiffPanelState,
  resolvePluginDiffPanel,
  withPluginDiffPanelState,
  type InstalledDiffPanel,
} from "./model";

interface Props {
  params: PluginDiffPanelParams;
  children: ReactNode;
}

function DiffPanelSurface({
  panel: { plugin, contribution },
  params,
  children,
  theme,
}: Props & { panel: InstalledDiffPanel; theme: PluginTheme }) {
  const { serverId, workspaceId, state, setCurrentTabState, panelRevision } = usePaneContext();
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const label = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const host = useMemo(() => ({ id: serverId, label }), [serverId, label]);
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const navigation = usePluginHostNavigation(serverId);
  const stateSource = useMemo(() => createPluginClientStateSource(serverId), [serverId]);
  const [modified, setModified] = useState(false);
  usePublishPanelInstanceAttributes({ modified });

  const key = `${plugin.id}/${contribution.id}`;
  const currentState: JsonValue | undefined =
    state ?? (params.kind === "working" ? defaultChangesState : undefined);
  const stateRef = useRef<JsonValue | undefined>(currentState);
  stateRef.current = currentState;
  const setState = useCallback(
    (next: JsonValue) => {
      const updated = withPluginDiffPanelState(stateRef.current, key, next);
      stateRef.current = updated;
      setCurrentTabState(updated);
    },
    [key, setCurrentTabState],
  );
  const tab = useMemo<PluginTab>(
    () => ({ state: readPluginDiffPanelState(currentState, key), setState, setModified }),
    [currentState, key, setState],
  );
  const Component = contribution.Component;
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Component}>
      <PluginInstallationProvider plugin={plugin}>
        <PluginClientStateProvider source={stateSource}>
          <Component
            params={params}
            revision={panelRevision ?? 0}
            tab={tab}
            theme={theme}
            host={host}
            layout={layout}
            navigation={navigation}
            workspaceId={workspaceId}
          >
            {children}
          </Component>
        </PluginClientStateProvider>
      </PluginInstallationProvider>
    </SurfaceErrorBoundary>
  );
}

const ThemedDiffPanelSurface = withUnistyles(DiffPanelSurface);
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

export function PluginDiffPanelHost({ params, children }: Props) {
  const { serverId } = usePaneContext();
  const plugins = useInstalledPlugins();
  const panel = resolvePluginDiffPanel(plugins, serverId);
  if (!panel) return children;
  return (
    <ThemedDiffPanelSurface
      key={`${serverId}/${panel.plugin.id}/${panel.contribution.id}`}
      panel={panel}
      params={params}
      uniProps={themeMapping}
    >
      {children}
    </ThemedDiffPanelSurface>
  );
}
