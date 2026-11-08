import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Workspaces } from "./client/workspaces";
import { Agents } from "./client/agents";
import { Nested } from "./client/nested";
import { Terminals } from "./client/terminals";
import { Labels } from "./client/labels";
export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addSidebarView({ id: "terminals", title: "Example terminals", Component: Terminals }),
    client.addSidebarView({ id: "workspaces", title: "Example workspaces", Component: Workspaces }),
    client.addSidebarView({ id: "agents", title: "Example agents", Component: Agents }),
    client.addSidebarView({ id: "nested", title: "Example nested agents", Component: Nested }),
    client.addSidebarView({ id: "labels", title: "Example label folders", Component: Labels }),
  ];
  return () => {
    for (const cleanup of cleanups) void cleanup();
  };
}
