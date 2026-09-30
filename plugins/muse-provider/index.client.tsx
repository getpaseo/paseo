import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MuseSettings } from "./client/settings.js";

export default function contribute(client: PluginClientContext) {
  client.addScreen({
    id: "muse",
    title: "Muse Code",
    Component: MuseSettings,
  });
  client.addCommandCenterItem({
    id: "settings",
    title: "Configure Muse Code",
    icon: "Settings",
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "muse" });
    },
  });
  return () => {};
}
