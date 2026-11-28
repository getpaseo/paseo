import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import { PluginInstallationProvider } from "@/plugins/installation-provider";
import { SurfaceErrorBoundary } from "@/plugins/surface-error-boundary";
import type { PluginFilePanel } from "./panels";

export function PluginFilePanelHost({
  panel,
  ...props
}: PluginFilePanelProps & { panel: PluginFilePanel }) {
  const { plugin, contribution } = panel;
  const Component = contribution.Component;
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Component} key={panel.id}>
      <PluginInstallationProvider plugin={plugin}>
        <Component {...props} />
      </PluginInstallationProvider>
    </SurfaceErrorBoundary>
  );
}
