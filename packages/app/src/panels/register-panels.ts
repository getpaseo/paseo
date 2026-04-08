import { agentPanelRegistration } from "@/panels/agent-panel";
import { browserPanelRegistration } from "@/panels/browser-panel";
import { draftPanelRegistration } from "@/panels/draft-panel";
import { filePanelRegistration } from "@/panels/file-panel";
import { registerPanel } from "@/panels/panel-registry";
import { terminalPanelRegistration } from "@/panels/terminal-panel";

let panelsRegistered = false;

export function ensurePanelsRegistered(): void {
  if (panelsRegistered) {
    return;
  }
  registerPanel(draftPanelRegistration);
  registerPanel(agentPanelRegistration);
  registerPanel(terminalPanelRegistration);
  registerPanel(browserPanelRegistration);
  registerPanel(filePanelRegistration);
  panelsRegistered = true;
}
