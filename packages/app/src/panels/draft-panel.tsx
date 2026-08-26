import { AgentConversationPanel, useDraftPanelDescriptor } from "@/panels/agent-panel";
import { definePanel } from "@/panels/panel-registry";

export const draftPanelRegistration = definePanel("draft", {
  component: AgentConversationPanel,
  useDescriptor: useDraftPanelDescriptor,
});
