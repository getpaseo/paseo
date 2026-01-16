import { readFile, writeFile, readdir, unlink, mkdir, stat } from "fs/promises";
import { join } from "path";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { standardizePrompt } from "ai/internal";

type LoggerLike = {
  child(bindings: Record<string, unknown>): LoggerLike;
  info(...args: any[]): void;
  debug(...args: any[]): void;
  error(...args: any[]): void;
};

function getLogger(logger: LoggerLike): LoggerLike {
  return logger.child({ module: "persistence" });
}

const CONVERSATIONS_DIR = join(process.cwd(), "conversations");

interface ConversationMetadata {
  id: string;
  lastUpdated: Date;
  messageCount: number;
}

interface ConversationData {
  conversationId: string;
  lastUpdated: string;
  messageCount: number;
  messages: ModelMessage[];
}

/**
 * Ensure conversations directory exists
 */
async function ensureConversationsDir(): Promise<void> {
  await mkdir(CONVERSATIONS_DIR, { recursive: true });
}

/**
 * Save conversation to disk
 */
export async function saveConversation(
  logger: LoggerLike,
  conversationId: string,
  messages: ModelMessage[]
): Promise<void> {
  const log = getLogger(logger);
  try {
    await ensureConversationsDir();

    const filepath = join(CONVERSATIONS_DIR, `${conversationId}.json`);
    const data: ConversationData = {
      conversationId,
      lastUpdated: new Date().toISOString(),
      messageCount: messages.length,
      messages,
    };

    await writeFile(filepath, JSON.stringify(data, null, 2), "utf-8");
    log.info(
      { conversationId, messageCount: messages.length },
      "Saved conversation"
    );
  } catch (error) {
    log.error(
      { err: error, conversationId },
      "Failed to save conversation"
    );
    throw error;
  }
}

/**
 * Load conversation from disk
 * Returns null if conversation doesn't exist or fails to parse
 */
export async function loadConversation(
  logger: LoggerLike,
  conversationId: string
): Promise<ModelMessage[] | null> {
  const log = getLogger(logger);
  try {
    const filepath = join(CONVERSATIONS_DIR, `${conversationId}.json`);

    // Check if file exists
    try {
      await stat(filepath);
    } catch {
      log.debug({ conversationId }, "Conversation not found");
      return null;
    }

    // Read and parse file
    const fileContent = await readFile(filepath, "utf-8");
    const data: ConversationData = JSON.parse(fileContent);

    // Validate and standardize messages using AI SDK utility
    const result = await standardizePrompt({
      prompt: data.messages,
    });

    log.info(
      { conversationId, messageCount: data.messageCount },
      "Loaded conversation"
    );

    return result.messages as ModelMessage[];
  } catch (error) {
    log.error(
      { err: error, conversationId },
      "Failed to load conversation"
    );
    return null;
  }
}

/**
 * List all conversations with metadata
 */
export async function listConversations(logger: LoggerLike): Promise<ConversationMetadata[]> {
  const log = getLogger(logger);
  try {
    await ensureConversationsDir();

    const files = await readdir(CONVERSATIONS_DIR);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    const conversations: ConversationMetadata[] = [];

    for (const file of jsonFiles) {
      try {
        const filepath = join(CONVERSATIONS_DIR, file);
        const fileContent = await readFile(filepath, "utf-8");
        const data: ConversationData = JSON.parse(fileContent);

        conversations.push({
          id: data.conversationId,
          lastUpdated: new Date(data.lastUpdated),
          messageCount: data.messageCount,
        });
      } catch (error) {
        log.error({ err: error, file }, "Failed to read conversation");
        // Skip invalid files
      }
    }

    // Sort by lastUpdated descending
    conversations.sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime());

    return conversations;
  } catch (error) {
    log.error({ err: error }, "Failed to list conversations");
    return [];
  }
}

/**
 * Delete conversation from disk
 */
export async function deleteConversation(logger: LoggerLike, conversationId: string): Promise<void> {
  const log = getLogger(logger);
  try {
    const filepath = join(CONVERSATIONS_DIR, `${conversationId}.json`);
    await unlink(filepath);
    log.info({ conversationId }, "Deleted conversation");
  } catch (error) {
    log.error(
      { err: error, conversationId },
      "Failed to delete conversation"
    );
    throw error;
  }
}
