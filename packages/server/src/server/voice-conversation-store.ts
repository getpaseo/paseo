import { readFile, writeFile, readdir, unlink, mkdir, stat } from "fs/promises";
import { join } from "path";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { standardizePrompt } from "ai/internal";

type LoggerLike = {
  child(bindings: Record<string, unknown>): LoggerLike;
  info(...args: any[]): void;
  debug(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
};

function getLogger(logger: LoggerLike): LoggerLike {
  return logger.child({ module: "voice-conversation-store" });
}

export interface VoiceConversationMetadata {
  id: string;
  lastUpdated: Date;
  messageCount: number;
}

interface VoiceConversationData {
  voiceConversationId: string;
  lastUpdated: string;
  messageCount: number;
  messages: ModelMessage[];
}

export class VoiceConversationStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private async ensureBaseDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  public async save(
    logger: LoggerLike,
    voiceConversationId: string,
    messages: ModelMessage[]
  ): Promise<void> {
    const log = getLogger(logger);
    await this.ensureBaseDir();

    const filepath = join(this.baseDir, `${voiceConversationId}.json`);
    const data: VoiceConversationData = {
      voiceConversationId,
      lastUpdated: new Date().toISOString(),
      messageCount: messages.length,
      messages,
    };

    await writeFile(filepath, JSON.stringify(data, null, 2), "utf-8");
    log.debug({ voiceConversationId, messageCount: messages.length }, "Saved voice conversation");
  }

  /**
   * Load voice conversation from disk.
   * Returns null when missing or invalid (best-effort).
   */
  public async load(
    logger: LoggerLike,
    voiceConversationId: string
  ): Promise<ModelMessage[] | null> {
    const log = getLogger(logger);
    const filepath = join(this.baseDir, `${voiceConversationId}.json`);

    try {
      await stat(filepath);
    } catch {
      log.debug({ voiceConversationId }, "Voice conversation not found");
      return null;
    }

    try {
      const fileContent = await readFile(filepath, "utf-8");
      const data: VoiceConversationData = JSON.parse(fileContent);

      const result = await standardizePrompt({ prompt: data.messages });

      log.debug(
        { voiceConversationId, messageCount: data.messageCount },
        "Loaded voice conversation"
      );

      return result.messages as ModelMessage[];
    } catch (error) {
      log.warn({ err: error, voiceConversationId }, "Failed to load voice conversation");
      return null;
    }
  }

  public async list(logger: LoggerLike): Promise<VoiceConversationMetadata[]> {
    const log = getLogger(logger);
    try {
      await this.ensureBaseDir();

      const files = await readdir(this.baseDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      const conversations: VoiceConversationMetadata[] = [];

      for (const file of jsonFiles) {
        try {
          const filepath = join(this.baseDir, file);
          const fileContent = await readFile(filepath, "utf-8");
          const data: VoiceConversationData = JSON.parse(fileContent);

          conversations.push({
            id: data.voiceConversationId,
            lastUpdated: new Date(data.lastUpdated),
            messageCount: data.messageCount,
          });
        } catch (error) {
          log.warn({ err: error, file }, "Failed to read voice conversation file");
        }
      }

      conversations.sort(
        (a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime()
      );
      return conversations;
    } catch (error) {
      log.warn({ err: error }, "Failed to list voice conversations");
      return [];
    }
  }

  public async delete(logger: LoggerLike, voiceConversationId: string): Promise<void> {
    const log = getLogger(logger);
    const filepath = join(this.baseDir, `${voiceConversationId}.json`);
    await unlink(filepath);
    log.debug({ voiceConversationId }, "Deleted voice conversation");
  }
}

