import type { PluginContext } from "@getpaseo/plugin";
import { ExamplePanel } from "./main.client";
import { increment } from "./increment.server";
import { incrementRpc } from "./increment.shared";

export default function contribute(plugin: PluginContext) {
  plugin.handle(incrementRpc, increment);
  plugin.addWorkspacePanel({
    id: "counter",
    title: "Plugin counter",
    icon: "Blocks",
    context: "workspace",
    Component: ExamplePanel,
  });
  plugin.addCommandCenterItem({
    id: "open-counter",
    title: "Open plugin counter",
    icon: "Blocks",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("counter");
    },
  });
  return () => {};
}
