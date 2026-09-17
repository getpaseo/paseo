import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DisplaySettings } from "./client/display-settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "display",
    title: "Display",
    icon: "SlidersHorizontal",
    Component: DisplaySettings,
  });
  client.addCommandCenterItem({
    id: "settings",
    title: "Configure agent monitor",
    icon: "Settings",
    context: "global",
    onSelect({ openSettings }) {
      openSettings("display");
    },
  });
  return () => {};
}
