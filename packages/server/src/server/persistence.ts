import { readFile, writeFile, readdir, unlink, mkdir, stat } from "fs/promises";
import { join } from "path";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { standardizePrompt } from "ai/internal";

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
  conversationId: string,
  messages: ModelMessage[]
): Promise<void> {
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
    console.log(
      `[Persistence] Saved conversation ${conversationId} (${messages.length} messages)`
    );
  } catch (error) {
    console.error(
      `[Persistence] Failed to save conversation ${conversationId}:`,
      error
    );
    throw error;
  }
}

/**
 * Load conversation from disk
 * Returns null if conversation doesn't exist or fails to parse
 */
export async function loadConversation(
  conversationId: string
): Promise<ModelMessage[] | null> {
  try {
    const filepath = join(CONVERSATIONS_DIR, `${conversationId}.json`);

    // Check if file exists
    try {
      await stat(filepath);
    } catch {
      console.log(`[Persistence] Conversation ${conversationId} not found`);
      return null;
    }

    // Read and parse file
    const fileContent = await readFile(filepath, "utf-8");
    const data: ConversationData = JSON.parse(fileContent);

    // Validate and standardize messages using AI SDK utility
    const result = await standardizePrompt({
      prompt: data.messages,
    });

    console.log(
      `[Persistence] Loaded conversation ${conversationId} (${data.messageCount} messages)`
    );

    return result.messages as ModelMessage[];
  } catch (error) {
    console.error(
      `[Persistence] Failed to load conversation ${conversationId}:`,
      error
    );
    return null;
  }
}

/**
 * List all conversations with metadata
 */
export async function listConversations(): Promise<ConversationMetadata[]> {
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
        console.error(`[Persistence] Failed to read conversation ${file}:`, error);
        // Skip invalid files
      }
    }

    // Sort by lastUpdated descending
    conversations.sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime());

    return conversations;
  } catch (error) {
    console.error("[Persistence] Failed to list conversations:", error);
    return [];
  }
}

/**
 * Delete conversation from disk
 */
export async function deleteConversation(conversationId: string): Promise<void> {
  try {
    const filepath = join(CONVERSATIONS_DIR, `${conversationId}.json`);
    await unlink(filepath);
    console.log(`[Persistence] Deleted conversation ${conversationId}`);
  } catch (error) {
    console.error(
      `[Persistence] Failed to delete conversation ${conversationId}:`,
      error
    );
    throw error;
  }
}
