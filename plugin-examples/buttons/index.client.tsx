import type { PluginAgentCommandContext, PluginClientContext } from "@getpaseo/plugin/client";
import { createButtonExamples, type ButtonMode } from "./client/examples";

export default function contribute(client: PluginClientContext) {
  // Keep one example active at a time, including when switching agents or workspaces.
  let current:
    | {
        workspaceId: string;
        agentId: string;
        buttons: ReturnType<typeof createButtonExamples>;
      }
    | undefined;

  function buttonsFor({ workspace, agent }: PluginAgentCommandContext) {
    if (current?.workspaceId !== workspace.id || current.agentId !== agent.id) {
      current?.buttons.remove();
      current = {
        workspaceId: workspace.id,
        agentId: agent.id,
        buttons: createButtonExamples(client, workspace.id, agent.id),
      };
    }
    return current.buttons;
  }

  for (const mode of ["action", "menu", "popover"] satisfies ButtonMode[]) {
    client.addCommandCenterItem({
      id: `show-${mode}`,
      title: `Button examples: ${mode}`,
      icon: "MousePointerClick",
      context: "agent",
      onSelect(context) {
        buttonsFor(context).setMode(mode);
      },
    });
  }
  for (const visible of [false, true]) {
    client.addCommandCenterItem({
      id: visible ? "show" : "hide",
      title: `Button examples: ${visible ? "show" : "hide"}`,
      icon: visible ? "Eye" : "EyeOff",
      context: "agent",
      onSelect(context) {
        buttonsFor(context).setVisible(visible);
      },
    });
  }
  for (const disabled of [true, false]) {
    client.addCommandCenterItem({
      id: disabled ? "disable" : "enable",
      title: `Button examples: ${disabled ? "disable" : "enable"}`,
      icon: "MousePointerClick",
      context: "agent",
      onSelect(context) {
        buttonsFor(context).setDisabled(disabled);
      },
    });
  }

  return () => current?.buttons.remove();
}
