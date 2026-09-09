import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ModalExamples } from "./client/examples";

export default function contribute(plugin: PluginClientContext) {
  plugin.addSurface("main", ModalExamples);
  plugin.addSidebarItem({
    id: "main",
    title: "Modal examples",
    icon: "PanelsTopLeft",
    surface: "main",
  });
  plugin.addWorkspacePanel({
    id: "examples",
    title: "Modal examples",
    icon: "PanelsTopLeft",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: ModalExamples,
  });
  return () => {};
}
