import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { SerialSettings } from "./client/settings";
import { SerialSession } from "./client/session";
import { getSerialBrowser } from "./client/web";
import {
  closeBridge,
  createBridge,
  pollBridge,
  renewBridge,
  writeBridge,
  releaseBridge,
} from "./shared/bridge";

export default function contribute(client: PluginClientContext) {
  // Each host installation owns its session independently of settings navigation.
  const browser = getSerialBrowser();
  const session = new SerialSession(browser, {
    create: (input) => client.rpc(createBridge, input),
    poll: (input) => client.rpc(pollBridge, input),
    renew: (input) => client.rpc(renewBridge, input),
    write: (input) => client.rpc(writeBridge, input),
    close: (input) => client.rpc(closeBridge, input),
    release: (input) => client.rpc(releaseBridge, input),
  });
  const cleanup = session.mount();
  client.addSettingsScreen({
    id: "devices",
    title: "USB serial",
    icon: "Usb",
    Component: (props) => <SerialSettings {...props} browser={browser} session={session} />,
  });
  function SerialSidebarItem() {
    const openDevices = useCallback(() => client.openSettings("devices"), []);
    return <SidebarRow icon="Usb" onPress={openDevices} />;
  }
  client.addSidebarHeaderItem({
    id: "devices",
    title: "USB serial",
    Component: SerialSidebarItem,
  });
  return cleanup;
}
