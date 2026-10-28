import type { PluginClientContext } from "@getpaseo/plugin/client";
import { EnvironmentPanel } from "./client/environment";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "environment",
    title: "Environment",
    icon: "KeyRound",
    context: "workspace",
    Component: EnvironmentPanel,
  });
  client.addCommandCenterItem({
    id: "open-environment",
    title: "Project environment",
    icon: "KeyRound",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("environment");
    },
  });
  return () => {};
}
