import { useCallback } from "react";
import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { ModalExamples } from "./client/examples";

function ModalExamplesItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const open = useCallback(() => openScreen({ screenId: "main" }), [openScreen]);
  return (
    <SidebarRow icon="PanelsTopLeft" active={currentScreen?.screenId === "main"} onPress={open} />
  );
}

export default function contribute(plugin: PluginClientContext) {
  plugin.addScreen({ id: "main", title: "Modal examples", Component: ModalExamples });
  plugin.addSidebarHeaderItem({
    id: "main",
    title: "Modal examples",
    Component: ModalExamplesItem,
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
