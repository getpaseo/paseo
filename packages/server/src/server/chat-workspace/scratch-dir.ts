import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { isPathInsideRoot } from "../../utils/path.js";

// Chat workspaces are daemon-owned scratch directories under $PASEO_HOME/chats.
// They exist so an agent can run without the user picking a project: the provider
// still gets a real cwd, and the workspace pipeline still gets a real directory.
export const CHATS_DIRNAME = "chats";

// Basename shape minted by ensureChatScratchDir. Classification and deletion key
// off this exact shape so they can only ever target directories this module created.
const CHAT_SCRATCH_BASENAME = /^chat-[0-9a-f]{12}$/;

export function resolveChatsRoot(paseoHome: string): string {
  return path.join(paseoHome, CHATS_DIRNAME);
}

export async function ensureChatScratchDir(paseoHome: string): Promise<string> {
  const scratchDir = path.join(
    resolveChatsRoot(paseoHome),
    `chat-${randomBytes(6).toString("hex")}`,
  );
  await mkdir(scratchDir, { recursive: true });
  return scratchDir;
}

// Two-way containment on normalized paths is equality that tolerates separator
// and drive-letter-case differences on Windows.
export function pathsReferToSameDirectory(left: string, right: string): boolean {
  return isPathInsideRoot(left, right) && isPathInsideRoot(right, left);
}

// True only for a daemon-minted scratch directory: a DIRECT child of the chats
// root named chat-<12hex>. Nested paths and arbitrary directories that merely
// live under the chats root never qualify, so a real user project can never be
// classified as a chat or deleted by chat cleanup.
export function isChatScratchDir(paseoHome: string, candidate: string): boolean {
  const resolved = path.resolve(candidate);
  if (!CHAT_SCRATCH_BASENAME.test(path.basename(resolved))) {
    return false;
  }
  const chatsRoot = path.resolve(resolveChatsRoot(paseoHome));
  return pathsReferToSameDirectory(chatsRoot, path.dirname(resolved));
}
