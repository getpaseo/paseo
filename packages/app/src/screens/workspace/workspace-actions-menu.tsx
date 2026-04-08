import type { ReactElement, ReactNode } from "react";
import { Copy, Globe, SquarePen, SquareTerminal } from "lucide-react-native";
import { useUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type TriggerState = {
  pressed: boolean;
  hovered: boolean;
  open: boolean;
};

interface WorkspaceActionsMenuProps {
  onCreateAgent: () => void;
  onCreateBrowser: () => void;
  onCreateTerminal: () => void;
  onCopyWorkspacePath: () => void;
  onCopyBranchName?: (() => void) | null;
  canCopyWorkspacePath: boolean;
  createTerminalPending?: boolean;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  width?: number;
  triggerTestID?: string;
  menuTestID?: string;
  newAgentTestID?: string;
  newBrowserTestID?: string;
  newTerminalTestID?: string;
  copyPathTestID?: string;
  copyBranchNameTestID?: string;
  children: (state: TriggerState) => ReactNode;
}

export function WorkspaceActionsMenu({
  onCreateAgent,
  onCreateBrowser,
  onCreateTerminal,
  onCopyWorkspacePath,
  onCopyBranchName,
  canCopyWorkspacePath,
  createTerminalPending = false,
  align = "start",
  side = "bottom",
  width = 220,
  triggerTestID,
  menuTestID,
  newAgentTestID,
  newBrowserTestID,
  newTerminalTestID,
  copyPathTestID,
  copyBranchNameTestID,
  children,
}: WorkspaceActionsMenuProps): ReactElement {
  const { theme } = useUnistyles();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        testID={triggerTestID}
        accessibilityRole="button"
        accessibilityLabel="Workspace actions"
      >
        {(state) => children(state)}
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} width={width} testID={menuTestID}>
        <DropdownMenuItem
          testID={newAgentTestID}
          leading={<SquarePen size={16} color={theme.colors.foregroundMuted} />}
          onSelect={onCreateAgent}
        >
          New agent
        </DropdownMenuItem>
        <DropdownMenuItem
          testID={newBrowserTestID}
          leading={<Globe size={16} color={theme.colors.foregroundMuted} />}
          onSelect={onCreateBrowser}
        >
          New browser
        </DropdownMenuItem>
        <DropdownMenuItem
          testID={newTerminalTestID}
          leading={<SquareTerminal size={16} color={theme.colors.foregroundMuted} />}
          disabled={createTerminalPending}
          onSelect={onCreateTerminal}
        >
          New terminal
        </DropdownMenuItem>
        <DropdownMenuItem
          testID={copyPathTestID}
          leading={<Copy size={16} color={theme.colors.foregroundMuted} />}
          disabled={!canCopyWorkspacePath}
          onSelect={onCopyWorkspacePath}
        >
          Copy workspace path
        </DropdownMenuItem>
        {onCopyBranchName ? (
          <DropdownMenuItem
            testID={copyBranchNameTestID}
            leading={<Copy size={16} color={theme.colors.foregroundMuted} />}
            onSelect={onCopyBranchName}
          >
            Copy branch name
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
