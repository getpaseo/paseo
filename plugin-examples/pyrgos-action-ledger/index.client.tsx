import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ActionLedgerPanel } from "./client/panel";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "action-ledger",
    title: "Action items",
    icon: "ListChecks",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: ActionLedgerPanel,
  });
  return () => {};
}
