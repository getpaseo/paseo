import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  AssistantSchema,
  AssistantTemplateSchema,
  AssistantHistoryEntrySchema,
  AssistantIdSchema,
  AssistantTemplateIdSchema,
  DEFAULT_ASSISTANT_CONFIGURATION,
  type Assistant,
  type AssistantTemplate,
  type AssistantHistoryEntry,
  type AssistantRequest,
} from "@getpaseo/protocol/assistants";
import { writeJsonFileAtomic } from "../atomic-file.js";

type Input<T extends AssistantRequest["type"]> = Omit<
  Extract<AssistantRequest, { type: T }>,
  "type" | "requestId"
>;
type EntryInput<T = AssistantHistoryEntry> = T extends AssistantHistoryEntry
  ? Omit<T, "seq" | "callId" | "createdAt">
  : never;
const RecordSchema = z.object({
  assistant: AssistantSchema,
  history: z.array(AssistantHistoryEntrySchema),
  archives: z.array(z.string().regex(/^\d+-\d+\.json$/)).optional(),
});
type AssistantRecord = z.infer<typeof RecordSchema>;

export class AssistantStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AssistantCallHandle {
  readonly assistant: Assistant;
  readonly history: AssistantHistoryEntry[];
  append(entry: EntryInput): Promise<void>;
  close(cause: string): Promise<void>;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export class AssistantStore {
  private readonly mutations = new Map<string, Promise<unknown>>();
  private readonly calls = new Map<
    string,
    { handle: AssistantCallHandle; onDeleted: () => void | Promise<void> }
  >();
  private readonly deleting = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  private principalDirectory(principal: string): string {
    if (!principal)
      throw new AssistantStoreError("unauthorized", "Assistant ownership is unavailable");
    return join(this.directory, createHash("sha256").update(principal).digest("hex"));
  }

  private path(principal: string, id: string, template = false): string {
    (template ? AssistantTemplateIdSchema : AssistantIdSchema).parse(id);
    return join(
      this.principalDirectory(principal),
      ...(template ? ["templates"] : []),
      `${id}.json`,
    );
  }

  private serial<T>(key: string, task: () => Promise<T>): Promise<T> {
    const work = (this.mutations.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
    this.mutations.set(key, work);
    void work
      .finally(() => {
        if (this.mutations.get(key) === work) this.mutations.delete(key);
      })
      .catch(() => {});
    return work;
  }

  async flush(): Promise<void> {
    while (this.mutations.size) await Promise.all(this.mutations.values());
  }

  private async read<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    try {
      return schema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (missing(error))
        throw new AssistantStoreError("not_found", "Assistant or template not found");
      throw error;
    }
  }

  private async ids(principal: string, template = false): Promise<string[]> {
    const directory = join(this.principalDirectory(principal), ...(template ? ["templates"] : []));
    try {
      return (await readdir(directory))
        .filter((name) =>
          (template ? /^tpl_[a-f0-9]{32}\.json$/ : /^ast_[a-f0-9]{32}\.json$/).test(name),
        )
        .map((name) => join(directory, name));
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  }

  private async history(path: string, record: AssistantRecord): Promise<AssistantHistoryEntry[]> {
    const archived = await Promise.all(
      (record.archives ?? []).map((file) =>
        this.read(join(`${path}.history`, file), z.array(AssistantHistoryEntrySchema)),
      ),
    );
    return [...archived.flat(), ...record.history];
  }

  private async writeRecord(path: string, record: AssistantRecord): Promise<void> {
    const summarized = record.history.filter(
      (entry) => entry.seq <= record.assistant.summaryThroughSeq,
    ).length;
    const archiveCount = Math.max(summarized, record.history.length > 512 ? 256 : 0);
    if (archiveCount > 0) {
      const entries = record.history.slice(0, archiveCount);
      const file = `${entries[0]!.seq}-${entries.at(-1)!.seq}.json`;
      // Write the immutable segment first. Only the atomic manifest replacement
      // makes it authoritative; an interrupted write cannot lose history.
      await writeJsonFileAtomic(join(`${path}.history`, file), entries);
      record.archives = [...(record.archives ?? []), file];
      record.history = record.history.slice(archiveCount);
    }
    await writeJsonFileAtomic(path, record);
  }

  async list(principal: string): Promise<Assistant[]> {
    const entries = await Promise.all(
      (await this.ids(principal)).map(async (path) => {
        try {
          return (await this.read(path, RecordSchema)).assistant;
        } catch (error) {
          if (error instanceof AssistantStoreError && error.code === "not_found") return null;
          throw error;
        }
      }),
    );
    return entries
      .filter((entry): entry is Assistant => entry !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(principal: string, id: string, page: { beforeSeq?: number; limit?: number } = {}) {
    const path = this.path(principal, id);
    await this.mutations.get(path);
    const record = await this.read(path, RecordSchema);
    const candidates = (await this.history(path, record)).filter(
      (entry) => page.beforeSeq === undefined || entry.seq < page.beforeSeq,
    );
    const limit = Math.min(200, Math.max(1, page.limit ?? 50));
    return {
      assistant: record.assistant,
      history: candidates.slice(-limit),
      hasMore: candidates.length > limit,
    };
  }

  async create(principal: string, input: Input<"assistant.create.request">): Promise<Assistant> {
    const template = input.templateId
      ? await this.read(this.path(principal, input.templateId, true), AssistantTemplateSchema)
      : null;
    const now = new Date().toISOString();
    const assistant = AssistantSchema.parse({
      id: `ast_${randomBytes(16).toString("hex")}`,
      name: input.name,
      templateId: template?.id ?? null,
      configuration:
        input.configuration ?? template?.configuration ?? DEFAULT_ASSISTANT_CONFIGURATION,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      summary: "",
      summaryThroughSeq: 0,
      lastSeq: 0,
    });
    await writeJsonFileAtomic(this.path(principal, assistant.id), { assistant, history: [] });
    return assistant;
  }

  private mutate(
    principal: string,
    id: string,
    change: (record: AssistantRecord) => void,
  ): Promise<Assistant> {
    const path = this.path(principal, id);
    return this.serial(path, async () => {
      if (this.deleting.has(path))
        throw new AssistantStoreError("not_found", "Assistant is being deleted");
      const record = await this.read(path, RecordSchema);
      change(record);
      const parsed = RecordSchema.parse(record);
      await this.writeRecord(path, parsed);
      return parsed.assistant;
    });
  }

  private checkRevision(assistant: { revision: number }, expected: number | undefined): void {
    if (assistant.revision !== expected)
      throw new AssistantStoreError("conflict", "This record changed. Reload before saving.");
  }

  update(principal: string, input: Input<"assistant.update.request">): Promise<Assistant> {
    return this.mutate(principal, input.assistantId, (record) => {
      this.checkRevision(record.assistant, input.expectedRevision);
      Object.assign(record.assistant, {
        name: input.name,
        configuration: input.configuration,
        revision: record.assistant.revision + 1,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  compact(principal: string, input: Input<"assistant.compact.request">): Promise<Assistant> {
    return this.mutate(principal, input.assistantId, (record) => {
      this.checkRevision(record.assistant, input.expectedRevision);
      if (
        input.throughSeq < record.assistant.summaryThroughSeq ||
        input.throughSeq > record.assistant.lastSeq
      )
        throw new AssistantStoreError(
          "invalid_checkpoint",
          "Choose a checkpoint within the saved history",
        );
      Object.assign(record.assistant, {
        summary: input.summary,
        summaryThroughSeq: input.throughSeq,
        revision: record.assistant.revision + 1,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async openCall(
    principal: string,
    id: string,
    callId: string,
    onDeleted: () => void | Promise<void>,
  ): Promise<AssistantCallHandle> {
    const path = this.path(principal, id);
    return this.serial(path, async () => {
      if (this.deleting.has(path))
        throw new AssistantStoreError("not_found", "Assistant is being deleted");
      const record = await this.read(path, RecordSchema);
      if (this.calls.has(path))
        throw new AssistantStoreError(
          "assistant_busy",
          "This assistant already has an active call",
        );
      const history = await this.history(path, record);
      const lastStart = history.findLast((entry) => entry.kind === "call_started");
      if (
        lastStart &&
        !history.some((entry) => entry.kind === "call_ended" && entry.callId === lastStart.callId)
      ) {
        this.addEntry(record, lastStart.callId, { kind: "call_ended", cause: "daemon_restarted" });
        history.push(record.history.at(-1)!);
      }
      let closed = false;
      let closing: Promise<void> | undefined;
      const append = (entry: EntryInput) =>
        this.serial(path, async () => {
          const current = await this.read(path, RecordSchema);
          this.addEntry(current, callId, entry);
          await this.writeRecord(path, current);
        });
      const handle: AssistantCallHandle = {
        assistant: structuredClone(record.assistant),
        history: structuredClone(history),
        append: (entry) => (closed || this.deleting.has(path) ? Promise.resolve() : append(entry)),
        close: (cause) => {
          closed = true;
          if (!closing) {
            closing = append({ kind: "call_ended", cause }).then(() => {
              if (this.calls.get(path)?.handle === handle) this.calls.delete(path);
              return;
            });
            void closing.catch(() => {
              closing = undefined;
            });
          }
          return closing;
        },
      };
      this.addEntry(record, callId, { kind: "call_started" });
      await this.writeRecord(path, record);
      this.calls.set(path, { handle, onDeleted });
      return handle;
    });
  }

  private addEntry(record: AssistantRecord, callId: string, entry: EntryInput): void {
    const createdAt = new Date().toISOString();
    record.history.push(
      AssistantHistoryEntrySchema.parse({
        ...entry,
        callId,
        seq: ++record.assistant.lastSeq,
        createdAt,
      }),
    );
    record.assistant.updatedAt = createdAt;
  }

  async delete(principal: string, id: string): Promise<void> {
    const path = this.path(principal, id);
    const pending = this.deleting.get(path);
    if (pending) return pending;
    const work = Promise.resolve().then(async () => {
      // Wait for a call reservation that was already writing its start entry.
      await this.serial(path, async () => {});
      const call = this.calls.get(path);
      if (call) {
        await call.onDeleted();
        await call.handle.close("assistant_deleted");
      }
      await this.serial(path, async () => {
        await rm(path, { force: true });
        await rm(`${path}.history`, { recursive: true, force: true });
      });
      return;
    });
    this.deleting.set(path, work);
    try {
      await work;
    } finally {
      this.deleting.delete(path);
    }
  }

  async listTemplates(principal: string): Promise<AssistantTemplate[]> {
    const templates = await Promise.all(
      (await this.ids(principal, true)).map(async (path) => {
        try {
          return await this.read(path, AssistantTemplateSchema);
        } catch (error) {
          if (error instanceof AssistantStoreError && error.code === "not_found") return null;
          throw error;
        }
      }),
    );
    return templates
      .filter((entry): entry is AssistantTemplate => entry !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveTemplate(
    principal: string,
    input: Input<"assistant.template.save.request">,
  ): Promise<AssistantTemplate> {
    const id = input.templateId ?? `tpl_${randomBytes(16).toString("hex")}`;
    const path = this.path(principal, id, true);
    return this.serial(path, async () => {
      const previous = input.templateId ? await this.read(path, AssistantTemplateSchema) : null;
      if (previous) this.checkRevision(previous, input.expectedRevision);
      const now = new Date().toISOString();
      const template = AssistantTemplateSchema.parse({
        id,
        name: input.name,
        configuration: input.configuration,
        revision: (previous?.revision ?? 0) + 1,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      });
      await writeJsonFileAtomic(path, template);
      return template;
    });
  }

  async deleteTemplate(principal: string, id: string): Promise<void> {
    const path = this.path(principal, id, true);
    await this.serial(path, () => rm(path, { force: true }));
  }
}
