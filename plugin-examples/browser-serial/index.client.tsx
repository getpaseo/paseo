import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SerialSettings } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "devices",
    title: "USB serial",
    icon: "Usb",
    Component: SerialSettings,
  });
  return () => {};
}
