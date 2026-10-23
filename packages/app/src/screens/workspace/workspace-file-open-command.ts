import {
  createWorkspaceFileTabTarget,
  normalizeWorkspaceFileLocation,
} from "@/workspace/file-open";
import {
  FOCUSED_PANE_PLACEMENT,
  type WorkspaceTabPlacement,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

interface OpenWorkspaceFileFromExplorerInput {
  filePath: string;
  persistenceKey: string | null;
  closeExplorerAfterOpen: boolean;
  showMobileAgent: () => void;
  openWorkspaceTabInFocusedPane: (
    workspaceKey: string,
    target: WorkspaceTabTarget,
    placement?: WorkspaceTabPlacement,
  ) => string | null;
  focusWorkspaceTab: (workspaceKey: string, tabId: string) => void;
}

function decodeEncodedUnicodePath(value: string): string {
  return value
    .split(/([\\/])/)
    .map((segment) => {
      if (segment === "/" || segment === "\\") {
        return segment;
      }
      try {
        const decoded = decodeURIComponent(segment);
        if (
          decoded === segment ||
          !containsNonAscii(decoded) ||
          decoded.includes("/") ||
          decoded.includes("\\") ||
          decoded.includes("\0")
        ) {
          return segment;
        }
        return decoded;
      } catch {
        return segment;
      }
    })
    .join("");
}

function containsNonAscii(value: string): boolean {
  return Array.from(value).some((character) => (character.codePointAt(0) ?? 0) > 0x7f);
}

export function openWorkspaceFileFromExplorer(input: OpenWorkspaceFileFromExplorerInput): void {
  if (input.closeExplorerAfterOpen) {
    input.showMobileAgent();
  }
  if (!input.persistenceKey) {
    return;
  }
  const location = normalizeWorkspaceFileLocation({
    path: decodeEncodedUnicodePath(input.filePath),
  });
  if (!location) {
    return;
  }
  const tabId = input.openWorkspaceTabInFocusedPane(
    input.persistenceKey,
    createWorkspaceFileTabTarget(location),
    FOCUSED_PANE_PLACEMENT,
  );
  if (tabId) {
    input.focusWorkspaceTab(input.persistenceKey, tabId);
  }
}
