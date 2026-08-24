import { generateMessageId } from "@/types/stream";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import type { TerminalProfile } from "@getpaseo/protocol/messages";

export type NewTabSelection =
  | { kind: "target"; target: WorkspaceTab["target"] }
  | { kind: "agent" }
  | { kind: "terminal"; profile?: TerminalProfile }
  | { kind: "browser" }
  // Agent-context plugin panels stay abstract until launch: the agent they
  // bind to is resolved at click time, like draft/terminal/browser ids.
  | { kind: "plugin-agent-panel"; pluginId: string; panelId: string };

export function createNewWorkspaceTab(): WorkspaceTab {
  return {
    tabId: `tab_${generateMessageId()}`,
    target: { kind: "new_tab" },
    createdAt: Date.now(),
  };
}
