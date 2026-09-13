import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerActions } from "./client/actions";
import { WorkflowSettings } from "./client/settings";
import { WorkflowPanel } from "./client/panel";

export default function contribute(client: PluginClientContext) {
  registerActions(client);
  client.addSettingsScreen({
    id: "profiles",
    title: "Workflow",
    icon: "Workflow",
    Component: WorkflowSettings,
  });
  client.addWorkspacePanel({
    id: "workflow",
    title: "Workflow",
    icon: "Workflow",
    context: "agent",
    Component: WorkflowPanel,
  });
  client.addCommandCenterItem({
    id: "profiles",
    title: "Install / repair workflow profiles",
    icon: "Workflow",
    context: "global",
    onSelect: ({ openSettings }) => openSettings("profiles"),
  });
  client.addCommandCenterItem({
    id: "status",
    title: "Open workflow review",
    icon: "Workflow",
    context: "agent",
    onSelect: ({ openPanel }) => openPanel("workflow"),
  });
  return () => {};
}
