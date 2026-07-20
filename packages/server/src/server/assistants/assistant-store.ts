import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type pino from "pino";
import { z } from "zod";
import {
  AssistantCreateInputSchema,
  AssistantSchema,
  AssistantUpdateInputSchema,
  type Assistant,
  type AssistantCreateInput,
  type AssistantUpdateInput,
} from "@getpaseo/protocol/messages";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";
import {
  applyAssistantMemoryFileEdits,
  cleanAssistantMemorySource,
  materializeAssistantMemoryFiles,
  removeAssistantMemoryFiles,
} from "./assistant-memory-files.js";

const ASSISTANT_STORE_VERSION = 1;

const AssistantStorePayloadSchema = z.object({
  version: z.literal(ASSISTANT_STORE_VERSION),
  assistants: z.array(AssistantSchema),
});

type AssistantStorePayload = z.infer<typeof AssistantStorePayloadSchema>;

function createDefaultPayload(): AssistantStorePayload {
  return { version: ASSISTANT_STORE_VERSION, assistants: [] };
}

function clonePayload(payload: AssistantStorePayload): AssistantStorePayload {
  return AssistantStorePayloadSchema.parse(JSON.parse(JSON.stringify(payload)));
}

function nowIso(): string {
  return new Date().toISOString();
}

function appendMemory(currentMemory: string, memoryAppend: string | undefined): string {
  if (memoryAppend === undefined) {
    return cleanAssistantMemorySource(currentMemory);
  }
  const normalizedAppend = cleanAssistantMemorySource(memoryAppend);
  if (normalizedAppend.length === 0) {
    return cleanAssistantMemorySource(currentMemory);
  }
  const normalizedCurrent = cleanAssistantMemorySource(currentMemory);
  if (normalizedCurrent.length === 0) {
    return normalizedAppend;
  }
  return `${normalizedCurrent}\n\n${normalizedAppend}`;
}

function hasNonEmptyMemoryAppend(memoryAppend: string | undefined): boolean {
  return memoryAppend !== undefined && cleanAssistantMemorySource(memoryAppend).length > 0;
}

export class AssistantStore {
  private readonly filePath: string;
  private readonly paseoHome: string;
  private readonly logger: pino.Logger;
  private loaded = false;
  private payload: AssistantStorePayload = createDefaultPayload();

  constructor(options: { paseoHome: string; logger: pino.Logger }) {
    this.paseoHome = options.paseoHome;
    this.filePath = path.join(options.paseoHome, "assistants.json");
    this.logger = options.logger.child({ module: "assistant-store" });
  }

  getFilePath(): string {
    return this.filePath;
  }

  list(): Assistant[] {
    this.ensureLoaded();
    return clonePayload(this.payload).assistants;
  }

  get(id: string): Assistant | null {
    this.ensureLoaded();
    return this.payload.assistants.find((assistant) => assistant.id === id) ?? null;
  }

  create(input: AssistantCreateInput): Assistant {
    this.ensureLoaded();
    const parsed = AssistantCreateInputSchema.parse(input);
    const timestamp = nowIso();
    const id = randomUUID();
    const memory = cleanAssistantMemorySource(parsed.memory ?? "");
    const memoryEnabled = parsed.memoryEnabled ?? false;
    const materializedMemory = materializeAssistantMemoryFiles({
      paseoHome: this.paseoHome,
      assistantId: id,
      memoryEnabled,
      memory,
    });
    const assistant = AssistantSchema.parse({
      id,
      name: (parsed.name ?? "").trim(),
      description: parsed.description?.trim() ?? "",
      prompt: parsed.prompt,
      memoryEnabled,
      memory,
      memorySummary: materializedMemory.memorySummary,
      memoryFiles: materializedMemory.memoryFiles,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.replaceAndPersist({
      ...this.payload,
      assistants: [...this.payload.assistants, assistant],
    });
    return assistant;
  }

  update(input: AssistantUpdateInput): Assistant | null {
    this.ensureLoaded();
    const parsed = AssistantUpdateInputSchema.parse(input);
    const index = this.payload.assistants.findIndex((assistant) => assistant.id === parsed.id);
    if (index < 0) {
      return null;
    }
    const current = this.payload.assistants[index]!;
    const memoryEnabled = parsed.memoryEnabled ?? current.memoryEnabled;
    const memoryAppendChanged = hasNonEmptyMemoryAppend(parsed.memoryAppend);
    const memory =
      parsed.memory !== undefined
        ? cleanAssistantMemorySource(parsed.memory)
        : appendMemory(current.memory, parsed.memoryAppend);
    const memorySourceChanged =
      parsed.memory !== undefined ||
      memoryAppendChanged ||
      (parsed.memoryEnabled !== undefined && parsed.memoryEnabled !== current.memoryEnabled);
    const memoryArtifactsEdited =
      parsed.memorySummary !== undefined || parsed.memoryDetailFileEdits !== undefined;
    let materializedMemory = memorySourceChanged
      ? materializeAssistantMemoryFiles({
          paseoHome: this.paseoHome,
          assistantId: current.id,
          memoryEnabled,
          memory,
        })
      : {
          memorySummary: current.memorySummary,
          memoryFiles: current.memoryFiles,
        };
    if (!memoryEnabled || memory.trim().length === 0) {
      removeAssistantMemoryFiles(this.paseoHome, current.id);
      materializedMemory = {
        memorySummary: "",
        memoryFiles: { summaryPath: "", detailFiles: [] },
      };
    } else if (memoryArtifactsEdited) {
      materializedMemory = applyAssistantMemoryFileEdits({
        memorySummary: materializedMemory.memorySummary,
        memoryFiles: materializedMemory.memoryFiles,
        summaryContent: parsed.memorySummary,
        detailFileEdits: parsed.memoryDetailFileEdits,
      });
    }
    const assistant = AssistantSchema.parse({
      ...current,
      ...(parsed.name !== undefined ? { name: parsed.name.trim() } : {}),
      ...(parsed.description !== undefined ? { description: parsed.description.trim() } : {}),
      ...(parsed.prompt !== undefined ? { prompt: parsed.prompt } : {}),
      memoryEnabled,
      memory,
      memorySummary: materializedMemory.memorySummary,
      memoryFiles: materializedMemory.memoryFiles,
      updatedAt: nowIso(),
    });
    const assistants = [...this.payload.assistants];
    assistants[index] = assistant;
    this.replaceAndPersist({ ...this.payload, assistants });
    return assistant;
  }

  delete(id: string): boolean {
    this.ensureLoaded();
    const assistants = this.payload.assistants.filter((assistant) => assistant.id !== id);
    if (assistants.length === this.payload.assistants.length) {
      return false;
    }
    removeAssistantMemoryFiles(this.paseoHome, id);
    this.replaceAndPersist({ ...this.payload, assistants });
    return true;
  }

  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }
    if (!existsSync(this.filePath)) {
      this.payload = createDefaultPayload();
      this.loaded = true;
      return;
    }
    ensurePrivateFile(this.filePath);
    const raw = readFileSync(this.filePath, "utf8");
    try {
      this.payload = this.migrateMemoryFiles(AssistantStorePayloadSchema.parse(JSON.parse(raw)));
    } catch (error) {
      this.logger.error({ err: error, filePath: this.filePath }, "Failed to parse assistant store");
      throw error;
    }
    this.loaded = true;
  }

  private replaceAndPersist(payload: AssistantStorePayload): void {
    const parsed = AssistantStorePayloadSchema.parse(payload);
    writePrivateFileAtomicSync(this.filePath, JSON.stringify(parsed, null, 2));
    this.payload = parsed;
    this.loaded = true;
  }

  private migrateMemoryFiles(payload: AssistantStorePayload): AssistantStorePayload {
    let changed = false;
    const assistants = payload.assistants.map((assistant) => {
      const memory = cleanAssistantMemorySource(assistant.memory);
      const materializedMemory = materializeAssistantMemoryFiles({
        paseoHome: this.paseoHome,
        assistantId: assistant.id,
        memoryEnabled: assistant.memoryEnabled,
        memory,
      });
      const next = AssistantSchema.parse({
        ...assistant,
        memory,
        memorySummary: materializedMemory.memorySummary,
        memoryFiles: materializedMemory.memoryFiles,
      });
      if (JSON.stringify(next) !== JSON.stringify(assistant)) {
        changed = true;
      }
      return next;
    });
    const nextPayload = { ...payload, assistants };
    if (changed) {
      writePrivateFileAtomicSync(this.filePath, JSON.stringify(nextPayload, null, 2));
    }
    return nextPayload;
  }
}
