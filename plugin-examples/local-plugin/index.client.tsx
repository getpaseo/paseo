import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeClient, ExamplePanel } from "./client/main";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "counter",
    title: "Plugin counter",
    icon: "Blocks",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: ExamplePanel,
  });
  client.addCommandCenterItem({
    id: "open-counter",
    title: "Open plugin counter",
    icon: "Blocks",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("counter");
    },
  });
  return contributeClient(client);
}
