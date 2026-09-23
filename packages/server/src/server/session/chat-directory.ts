import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
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
 * Validates a session ID to ensure it is a safe single path segment that cannot
 * escape the chat root directory.
 */
export function isValidChatSessionId(sessionId: string): boolean {
  if (!sessionId || typeof sessionId !== "string") {
    return false;
  }
  const trimmed = sessionId.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    return false;
  }
  // Strictly alphanumeric, hyphens, and underscores only.
  // This precludes '.', '..', '/', '\', null bytes, and path traversal characters.
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return false;
  }
  if (basename(trimmed) !== trimmed) {
    return false;
  }
  return true;
}

export function assertValidChatSessionId(sessionId: string): void {
  if (!isValidChatSessionId(sessionId)) {
    throw new Error(
      `Invalid chat session ID: "${sessionId}". Must be a single path segment with alphanumeric characters, underscores, or hyphens.`,
    );
  }
}

/**
 * Generates an 8-character random alphanumeric session ID (e.g. "gtgys857").
 */
export function generateChatSessionId(): string {
  return Math.random().toString(36).substring(2, 10);
}

/**
 * Ensures a chat session directory exists and writes session.json metadata.
 * Allocates the directory exclusively and validates that the session ID does not
 * escape the base chat directory.
 */
export async function ensureChatSessionDirectory(
  baseDir: string,
  sessionId?: string,
): Promise<{ chatDir: string; sessionId: string }> {
  const resolvedBaseDir = resolve(baseDir);
  mkdirSync(resolvedBaseDir, { recursive: true });

  let allocatedSessionId: string;
  let chatDir: string;

  if (sessionId !== undefined && sessionId.trim().length > 0) {
    const candidateId = sessionId.trim();
    assertValidChatSessionId(candidateId);
    allocatedSessionId = candidateId;
    chatDir = resolve(resolvedBaseDir, candidateId);

    // Verify containment within resolvedBaseDir
    if (!chatDir.startsWith(resolvedBaseDir + sep)) {
      throw new Error(`Chat session ID "${candidateId}" escapes the chats directory`);
    }

    // Allocate exclusively: reject existing directories
    if (existsSync(chatDir)) {
      throw new Error(`Chat session directory already exists for ID: "${candidateId}"`);
    }

    try {
      mkdirSync(chatDir);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Chat session directory already exists for ID: "${candidateId}"`, {
          cause: error,
        });
      }
      throw error;
    }
  } else {
    // Generate an unallocated random session ID exclusively
    let attempts = 0;
    let allocated = false;
    allocatedSessionId = "";
    chatDir = "";

    while (attempts < 100) {
      attempts++;
      const candidateId = generateChatSessionId();
      const candidatePath = resolve(resolvedBaseDir, candidateId);
      try {
        mkdirSync(candidatePath);
        allocatedSessionId = candidateId;
        chatDir = candidatePath;
        allocated = true;
        break;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          continue;
        }
        throw error;
      }
    }

    if (!allocated || !chatDir || !allocatedSessionId) {
      throw new Error("Failed to allocate a unique chat session directory");
    }
  }

  const metadataPath = join(chatDir, "session.json");
  const metadata = {
    sessionId: allocatedSessionId,
    createdAt: new Date().toISOString(),
  };
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx",
  });

  return { chatDir, sessionId: allocatedSessionId };
}
