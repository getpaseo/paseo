import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useCallback } from "react";
import { ImportScreen } from "./client/import-screen";

function LocalFilesItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const open = useCallback(() => openScreen({ screenId: "import" }), [openScreen]);
  return <SidebarRow icon="FileUp" active={currentScreen?.screenId === "import"} onPress={open} />;
}

export default function contribute(client: PluginClientContext) {
  const removeScreen = client.addScreen({
    id: "import",
    title: "Local Files",
    Component: ImportScreen,
  });
  const removeItem = client.addSidebarHeaderItem({
    id: "local-files",
    title: "Local Files",
    Component: LocalFilesItem,
  });
  return () => {
    removeItem();
    removeScreen();
  };
}
