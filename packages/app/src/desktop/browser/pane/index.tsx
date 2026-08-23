import { BrowserMirrorPane } from "@/desktop/browser/mirror/pane";

interface BrowserPaneProps {
  browserId: string;
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  isInteractive?: boolean;
  onFocusPane?: () => void;
}

export function BrowserPane({ browserId, serverId, workspaceId, isInteractive }: BrowserPaneProps) {
  return (
    <BrowserMirrorPane
      browserId={browserId}
      serverId={serverId}
      workspaceId={workspaceId}
      isInteractive={isInteractive}
    />
  );
}
