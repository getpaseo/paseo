import { agentPanelRegistration } from "@/panels/agent-panel";
import { draftPanelRegistration } from "@/panels/draft-panel";
import { filePanelRegistration } from "@/panels/file-panel";
import { registerPanel } from "@/panels/panel-registry";
import { setupPanelRegistration } from "@/panels/setup-panel";
import { terminalPanelRegistration } from "@/panels/terminal-panel";

let panelsRegistered = false;

export function ensurePanelsRegistered(): void {
  if (panelsRegistered) {
    return;
  }
  registerPanel(draftPanelRegistration);
  registerPanel(agentPanelRegistration);
  registerPanel(setupPanelRegistration);
  registerPanel(terminalPanelRegistration);
  registerPanel(filePanelRegistration);
  panelsRegistered = true;
}
