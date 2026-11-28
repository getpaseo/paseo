import { useCallback } from "react";
import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Agents } from "./client/agents";

function AgentsItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const open = useCallback(() => openScreen({ screenId: "main" }), [openScreen]);
  return <SidebarRow icon="Bot" active={currentScreen?.screenId === "main"} onPress={open} />;
}

export default function contribute(plugin: PluginClientContext) {
  plugin.addScreen({ id: "main", title: "Agents", Component: Agents });
  plugin.addSidebarHeaderItem({ id: "main", title: "Agents", Component: AgentsItem });
  return () => {};
}
