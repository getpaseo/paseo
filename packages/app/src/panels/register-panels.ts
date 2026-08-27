import { agentPanelRegistration } from "@/panels/agent-panel";
import { browserPanelRegistration } from "@/desktop/browser/panel";
import {
  changesTreePanelRegistration,
  commitDiffPanelRegistration,
  workingDiffPanelRegistration,
} from "@/panels/diff-panel";
import { draftPanelRegistration } from "@/panels/draft-panel";
import { filePanelRegistration } from "@/panels/file-panel";
import { filesPanelRegistration } from "@/panels/files-panel";
import { registerPanel } from "@/panels/panel-registry";
import { setupPanelRegistration } from "@/panels/setup-panel";
import { terminalPanelRegistration } from "@/panels/terminal-panel";
import { providerSubagentPanelRegistration } from "@/panels/provider-subagent-panel";
import { pullRequestPanelRegistration } from "@/panels/pull-request-panel";
import { pluginPanelRegistration } from "@/plugins/workspace-panels/panel";
import { newTabPanelRegistration } from "@/panels/new-tab-panel";

let panelsRegistered = false;

export function ensurePanelsRegistered(): void {
  if (panelsRegistered) {
    return;
  }
  registerPanel(draftPanelRegistration);
  registerPanel(newTabPanelRegistration);
  registerPanel(agentPanelRegistration);
  registerPanel(providerSubagentPanelRegistration);
  registerPanel(setupPanelRegistration);
  registerPanel(terminalPanelRegistration);
  registerPanel(browserPanelRegistration);
  registerPanel(filePanelRegistration);
  registerPanel(filesPanelRegistration);
  registerPanel(pullRequestPanelRegistration);
  registerPanel(commitDiffPanelRegistration);
  registerPanel(workingDiffPanelRegistration);
  registerPanel(changesTreePanelRegistration);
  registerPanel(pluginPanelRegistration);
  panelsRegistered = true;
}
