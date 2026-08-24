import { AgentConversationPanel, useDraftPanelDescriptor } from "@/panels/agent-panel";
import type { PanelRegistration } from "@/panels/panel-registry";

export const draftPanelRegistration: PanelRegistration<"draft"> = {
  kind: "draft",
  resourceKey: (target) => target.draftId,
  component: AgentConversationPanel,
  useDescriptor: useDraftPanelDescriptor,
};
