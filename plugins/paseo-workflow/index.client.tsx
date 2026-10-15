import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { registerActions } from "./client/actions";
import { WorkflowSettings } from "./client/settings";
import { WorkflowPanel } from "./client/panel";
import { z } from "zod";
import { PlanCard } from "@getpaseo/plugin/client/ui";
import { extractHandoffPlan } from "./shared/handoff-presentation";

function HandoffPlanCard({ item }: PluginTimelineItemProps<{ text: string }>) {
  return <PlanCard title="Plan transféré" text={item.data.text} testID="handoff-plan-card" />;
}

export default function contribute(client: PluginClientContext) {
  client.addTimelineTransformer({
    id: "handoff-plan",
    query: { itemType: "user_message" },
    transform({ item }) {
      const handoff = extractHandoffPlan(item.text);
      return handoff
        ? {
            items: [
              { type: "plugin", kind: "handoff-plan", version: 1, data: { text: handoff.text } },
            ],
          }
        : undefined;
    },
  });
  client.addTimelineRenderer({
    kind: "handoff-plan",
    version: 1,
    schema: z.object({ text: z.string() }),
    Component: HandoffPlanCard,
  });
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
