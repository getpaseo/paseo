import path from "node:path";

import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";
import {
  type DirectoryProjectMembership,
  deriveWorkspaceDirectoryKey,
} from "../workspace-registry-bootstrap-legacy.js";
import { isChatScratchDir, resolveChatsRoot } from "./scratch-dir.js";

// Every chat scratch dir groups under one synthetic project so the sidebar shows
// a single "Chats" entry instead of one project per scratch dir. The project
// identity is the chats root path: stable across daemon restarts (PASEO_HOME is
// fixed) and shared by every chat cwd, which is what collapses them into one
// project record on create, re-open, and project resolution.
export const CHATS_PROJECT_NAME = "Chats";

export function classifyChatWorkspaceMembership(input: {
  paseoHome: string;
  cwd: string;
  checkout: ProjectCheckoutLitePayload;
}): DirectoryProjectMembership | null {
  const normalizedCwd = path.resolve(input.cwd);
  if (!isChatScratchDir(input.paseoHome, normalizedCwd)) {
    return null;
  }

  const chatsRoot = path.resolve(resolveChatsRoot(input.paseoHome));
  const checkout: ProjectCheckoutLitePayload = {
    ...input.checkout,
    cwd: normalizedCwd,
  };

  return {
    cwd: normalizedCwd,
    checkout,
    workspaceDirectoryKey: deriveWorkspaceDirectoryKey(normalizedCwd, checkout),
    workspaceKind: "directory",
    workspaceDisplayName: path.basename(normalizedCwd),
    projectKey: chatsRoot,
    projectName: CHATS_PROJECT_NAME,
    projectRootPath: chatsRoot,
    projectKind: "non_git",
  };
}
