import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MediaPanel } from "./client/media-panel";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "media",
    title: "Media stream",
    icon: "MonitorPlay",
    context: "workspace",
    Component: MediaPanel,
  });
  client.addCommandCenterItem({
    id: "open-media",
    title: "Open media stream",
    icon: "MonitorPlay",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("media");
    },
  });
  return () => {};
}
