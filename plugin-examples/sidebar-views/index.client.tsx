import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Workspaces } from "./client/workspaces";

export default function contribute(client: PluginClientContext) {
  return client.addSidebarView({
    id: "workspaces",
    title: "Example workspaces",
    Component: Workspaces,
  });
}
