import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import { createPluginClientStateSource } from "@/plugins/client-state/source";
import { useMemo } from "react";
import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePaneContext } from "@/panels/pane-context";
import { useHosts } from "@/runtime/host-runtime";
import { usePluginLayout } from "@/plugins/layout";
import { toPluginTheme } from "@/plugins/theme";
import type { Theme } from "@/styles/theme";
import type { FilePanel } from "./panels";
import { BuiltinFilePanelView } from "./builtin";
import { PluginFilePanelHost } from "./plugin-host";

type Props = Pick<PluginFilePanelProps, "file" | "tab" | "params" | "revision"> & {
  panel: FilePanel;
};
function FilePanelHost({ panel, theme, ...input }: Props & { theme: PluginTheme }) {
  const { workspaceId, serverId } = usePaneContext();
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const label = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const host = useMemo(() => ({ id: serverId, label }), [serverId, label]);
  const layout = usePluginLayout(compact);
  const stateSource = useMemo(() => createPluginClientStateSource(serverId), [serverId]);
  const props: PluginFilePanelProps = { ...input, workspaceId, theme, host, layout };
  if (panel.builtin)
    return (
      <PluginClientStateProvider source={stateSource}>
        <BuiltinFilePanelView {...props} panel={panel} />
      </PluginClientStateProvider>
    );
  return <PluginFilePanelHost {...props} panel={panel} />;
}
const ThemedHost = withUnistyles(FilePanelHost);
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });
export function FilePanelView(props: Props) {
  return <ThemedHost {...props} uniProps={themeMapping} />;
}
