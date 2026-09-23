import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Hosts } from "./client/hosts";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", Hosts);
  client.addSidebarItem({ id: "hosts", title: "Host agents", icon: "Server", surface: "main" });
  return () => {};
}
