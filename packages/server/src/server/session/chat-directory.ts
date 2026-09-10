import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandTilde } from "../../utils/path.js";

/**
 * Resolves the root directory where chat session folders live.
 * Priority:
 * 1. Explicit customDir from request if supplied
 * 2. PASEO_CHATS_DIR environment variable
 * 3. ~/paseo-chat-sessions (if exists, or default)
 * 4. ~/.paseo/chats (fallback if paseoHome is given)
 */
export function resolvePaseoChatsDirectory(paseoHome?: string, customDir?: string): string {
  if (customDir && customDir.trim().length > 0) {
    return resolve(expandTilde(customDir.trim()));
  }
  if (process.env.PASEO_CHATS_DIR) {
    return resolve(expandTilde(process.env.PASEO_CHATS_DIR.trim()));
  }
  const userChatSessions = resolve(homedir(), "paseo-chat-sessions");
  if (existsSync(userChatSessions)) {
    return userChatSessions;
  }
  if (paseoHome) {
    return resolve(paseoHome, "chats");
  }
  return userChatSessions;
}

/**
 * Generates an 8-character random alphanumeric session ID (e.g. "gtgys857").
 */
export function generateChatSessionId(): string {
  return Math.random().toString(36).substring(2, 10);
}

/**
 * Ensures a chat session directory exists and writes session.json metadata.
 */
export async function ensureChatSessionDirectory(
  baseDir: string,
  sessionId: string,
): Promise<{ chatDir: string; sessionId: string }> {
  const chatDir = join(baseDir, sessionId);
  mkdirSync(chatDir, { recursive: true });

  const metadataPath = join(chatDir, "session.json");
  if (!existsSync(metadataPath)) {
    const metadata = {
      sessionId,
      createdAt: new Date().toISOString(),
    };
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");
  }

  return { chatDir, sessionId };
}
