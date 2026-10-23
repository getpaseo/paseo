import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ActionLedgerPanel } from "./client/panel";
import { VoicePanel } from "./client/voice-panel";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "action-ledger",
    title: "Action items",
    icon: "ListChecks",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: ActionLedgerPanel,
  });
  client.addWorkspacePanel({
    id: "voice",
    title: "Voice",
    icon: "AudioLines",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: VoicePanel,
  });
  return () => {};
}
