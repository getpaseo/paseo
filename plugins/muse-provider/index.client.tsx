import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MuseSettings } from "./client/settings.js";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "muse",
    title: "Muse Code",
    icon: "SlidersHorizontal",
    Component: MuseSettings,
  });
  client.addCommandCenterItem({
    id: "settings",
    title: "Configure Muse Code",
    icon: "Settings",
    context: "global",
    onSelect({ openSettings }) {
      openSettings("muse");
    },
  });
  return () => {};
}
