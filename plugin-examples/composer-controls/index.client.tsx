import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Checklist, ContextLength, PlanFirst, REVIEW_KEY, ReviewFlag } from "./client/controls";
import { ComposerTools } from "./client/panel";

export default function contribute(client: PluginClientContext) {
  client.addComposerItem({ id: "context-length", Component: ContextLength });
  client.addComposerItem({ id: "review-flag", Component: ReviewFlag });
  client.addComposerItem({ id: "plan-first", Component: PlanFirst });
  client.addComposerItem({ id: "checklist", Component: Checklist });
  client.addWorkspacePanel({
    id: "composer-tools",
    title: "Composer tools",
    icon: "ListChecks",
    locations: ["explorer"],
    Component: ComposerTools,
  });
  client.addCommandCenterItem({
    id: "mark-for-review",
    title: "Composer controls: mark for review",
    icon: "Flag",
    context: "agent",
    async onSelect({ agent, composers }) {
      // The agent's tab does not have to be open.
      for (const composer of composers({ agentId: agent.id })) {
        await composer.setMetadata({ [REVIEW_KEY]: true });
      }
    },
  });
  return () => {};
}
