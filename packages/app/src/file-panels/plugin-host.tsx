import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { usePluginHostNavigation } from "@/plugins/host-navigation";
import { createPluginClientStateSource } from "@/plugins/client-state/source";
import { PluginInstallationProvider } from "@/plugins/installation-provider";
import { SurfaceErrorBoundary } from "@/plugins/surface-error-boundary";
import type { PluginFilePanel } from "./panels";

export function PluginFilePanelHost({
  panel,
  ...props
}: PluginFilePanelProps & { panel: PluginFilePanel }) {
  const { plugin, contribution } = panel;
  const navigation = usePluginHostNavigation(plugin.serverId, plugin.id);
  const stateSource = useMemo(
    () => createPluginClientStateSource(plugin.serverId),
    [plugin.serverId],
  );
  const Component = contribution.Component;
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Component} key={panel.id}>
      <PluginInstallationProvider plugin={plugin}>
        <PluginClientStateProvider source={stateSource}>
          <Component {...props} navigation={navigation} />
        </PluginClientStateProvider>
      </PluginInstallationProvider>
    </SurfaceErrorBoundary>
  );
}
