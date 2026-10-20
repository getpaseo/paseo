import { useMemo } from "react";
import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import type { PluginTheme } from "@getpaseo/plugin";
import { withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePaneContext } from "@/panels/pane-context";
import { useHosts } from "@/runtime/host-runtime";
import { createPluginClientStateSource } from "@/plugins/client-state/source";
import { usePluginHostNavigation } from "@/plugins/host-navigation";
import { PluginInstallationProvider } from "@/plugins/installation-provider";
import { SurfaceErrorBoundary } from "@/plugins/surface-error-boundary";
import { resolvePluginPlatform } from "@/plugins/platform";
import { toPluginTheme } from "@/plugins/theme";
import type { Theme } from "@/styles/theme";
import type { BuiltinFilePanelProps, PluginFilePanel } from "./panels";

type Props = Pick<BuiltinFilePanelProps, "file" | "tab" | "location"> & { panel: PluginFilePanel };

function PluginHost({ panel, file, tab, location, theme }: Props & { theme: PluginTheme }) {
  const { workspaceId } = usePaneContext();
  const { plugin, contribution } = panel;
  const serverId = plugin.serverId;
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const navigation = usePluginHostNavigation(serverId);
  const stateSource = useMemo(() => createPluginClientStateSource(serverId), [serverId]);
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const host = useMemo(() => ({ id: serverId, label: hostLabel }), [serverId, hostLabel]);
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const Component = contribution.Component;
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Component} key={panel.id}>
      <PluginInstallationProvider plugin={plugin}>
        <PluginClientStateProvider source={stateSource}>
          <Component
            theme={theme}
            host={host}
            layout={layout}
            navigation={navigation}
            workspaceId={workspaceId}
            file={file}
            tab={tab}
            location={location}
          />
        </PluginClientStateProvider>
      </PluginInstallationProvider>
    </SurfaceErrorBoundary>
  );
}
const ThemedHost = withUnistyles(PluginHost);
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });
export function PluginFilePanelHost(props: Props) {
  return <ThemedHost {...props} uniProps={themeMapping} />;
}
