import { agentPanelRegistration } from "@/panels/agent-panel";
import { browserPanelRegistration } from "@/desktop/browser/panel";
import { commitDiffPanelRegistration, workingDiffPanelRegistration } from "@/panels/diff-panel";
import { draftPanelRegistration } from "@/panels/draft-panel";
import { filePanelRegistration } from "@/panels/file-panel";
import { scratchFilePanelRegistration } from "@/panels/scratch-file-panel";
import { registerPanel } from "@/panels/panel-registry";
import { setupPanelRegistration } from "@/panels/setup-panel";
import { terminalPanelRegistration } from "@/panels/terminal-panel";
import { providerSubagentPanelRegistration } from "@/panels/provider-subagent-panel";

let panelsRegistered = false;

export function ensurePanelsRegistered(): void {
  if (panelsRegistered) {
    return;
  }
  registerPanel(draftPanelRegistration);
  registerPanel(agentPanelRegistration);
  registerPanel(providerSubagentPanelRegistration);
  registerPanel(setupPanelRegistration);
  registerPanel(terminalPanelRegistration);
  registerPanel(browserPanelRegistration);
  registerPanel(filePanelRegistration);
  registerPanel(scratchFilePanelRegistration);
  registerPanel(commitDiffPanelRegistration);
  registerPanel(workingDiffPanelRegistration);
  panelsRegistered = true;
}
