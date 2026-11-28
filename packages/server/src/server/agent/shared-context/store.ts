import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";

import { writeJsonFileAtomic } from "../../atomic-file.js";

export const SHARED_CONTEXT_KINDS = ["research", "learning", "preference", "note"] as const;
export type SharedContextKind = (typeof SHARED_CONTEXT_KINDS)[number];

export const SharedContextEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(SHARED_CONTEXT_KINDS),
  title: z.string().min(1),
  body: z.string().min(1),
  authorAgentId: z.string().nullable(),
  authorLabel: z.string().nullable(),
  createdAt: z.string(),
});
export type SharedContextEntry = z.infer<typeof SharedContextEntrySchema>;

const SharedContextFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(SharedContextEntrySchema).default([]),
});

export const SHARED_CONTEXT_MAX_TITLE_LENGTH = 200;
export const SHARED_CONTEXT_MAX_BODY_LENGTH = 4_000;
export const SHARED_CONTEXT_MAX_ENTRIES_PER_PROJECT = 300;
/** Character budget for the digest injected into new agents' system prompts. */
export const SHARED_CONTEXT_DIGEST_MAX_CHARS = 6_000;

export class SharedContextLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedContextLimitError";
  }
}

export interface SaveSharedContextInput {
  kind: SharedContextKind;
  title: string;
  body: string;
  authorAgentId?: string | null;
  authorLabel?: string | null;
}

/**
 * Per-project shared context: durable knowledge (research findings, learnings,
 * preferences) contributed by agents, persisted under the Paseo home, and
 * inherited automatically by every future agent on the project via the digest
 * rendered by {@link SharedContextStore.renderDigest}.
 *
 * Entries live at `<paseoHome>/projects/<projectId>/shared-context.json` using
 * the same atomic-write pattern as the workspace registries. Writes for one
 * project are serialized through an in-flight chain so concurrent agent saves
 * cannot lose each other's entries.
 */
export class SharedContextStore {
  private readonly paseoHome: string;
  private readonly logger: Logger;
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  constructor(options: { paseoHome: string; logger: Logger }) {
    this.paseoHome = options.paseoHome;
    this.logger = options.logger.child({ module: "agent", component: "shared-context-store" });
  }

  async list(projectId: string): Promise<SharedContextEntry[]> {
    const file = await this.loadFile(projectId);
    return [...file.entries];
  }

  async get(projectId: string, ids: string[]): Promise<SharedContextEntry[]> {
    const wanted = new Set(ids);
    const entries = await this.list(projectId);
    return entries.filter((entry) => wanted.has(entry.id));
  }

  async save(projectId: string, input: SaveSharedContextInput): Promise<SharedContextEntry> {
    const title = input.title.trim();
    if (!title) {
      throw new Error("title is required");
    }
    if (title.length > SHARED_CONTEXT_MAX_TITLE_LENGTH) {
      throw new SharedContextLimitError(
        `title exceeds ${SHARED_CONTEXT_MAX_TITLE_LENGTH} characters (got ${title.length})`,
      );
    }
    const body = input.body.trim();
    if (!body) {
      throw new Error("body is required");
    }
    if (body.length > SHARED_CONTEXT_MAX_BODY_LENGTH) {
      throw new SharedContextLimitError(
        `body exceeds ${SHARED_CONTEXT_MAX_BODY_LENGTH} characters (got ${body.length}); split long material into multiple entries`,
      );
    }

    const entry: SharedContextEntry = {
      id: `ctx_${randomBytes(8).toString("hex")}`,
      kind: input.kind,
      title,
      body,
      authorAgentId: input.authorAgentId?.trim() || null,
      authorLabel: input.authorLabel?.trim() || null,
      createdAt: new Date().toISOString(),
    };

    return this.enqueueWrite(projectId, async () => {
      const file = await this.loadFile(projectId);
      if (file.entries.length >= SHARED_CONTEXT_MAX_ENTRIES_PER_PROJECT) {
        throw new SharedContextLimitError(
          `shared context for this project is full (${SHARED_CONTEXT_MAX_ENTRIES_PER_PROJECT} entries); remove stale knowledge before adding more`,
        );
      }
      const nextFile = { version: 1 as const, entries: [...file.entries, entry] };
      await writeJsonFileAtomic(this.filePathFor(projectId), nextFile);
      return entry;
    });
  }

  /**
   * Render the digest injected into new agents' system prompts, or null when
   * the project has no shared context. Newest entries first, capped at
   * {@link SHARED_CONTEXT_DIGEST_MAX_CHARS}; older entries are summarized as
   * omitted and remain reachable through the context_list/context_read tools.
   */
  async renderDigest(projectId: string): Promise<string | null> {
    const entries = (await this.list(projectId)).toReversed();
    if (entries.length === 0) {
      return null;
    }

    const lines: string[] = [
      "<shared-project-context>",
      "Durable knowledge about this project, contributed by earlier Paseo agents and shared with every agent that works here (newest first). Treat it as background: verify specifics that matter, and record what you learn with the context_save tool — entries you save are injected into every future agent on this project.",
      "",
    ];
    let used = 0;
    let rendered = 0;
    for (const entry of entries) {
      const block = formatDigestEntry(entry);
      if (used + block.length > SHARED_CONTEXT_DIGEST_MAX_CHARS && rendered > 0) {
        break;
      }
      lines.push(block, "");
      used += block.length;
      rendered += 1;
    }
    const omitted = entries.length - rendered;
    if (omitted > 0) {
      lines.push(
        `(${omitted} older entr${omitted === 1 ? "y" : "ies"} omitted — read with context_list and context_read.)`,
        "",
      );
    }
    lines.push("</shared-project-context>");
    return lines.join("\n");
  }

  private async enqueueWrite<T>(projectId: string, write: () => Promise<T>): Promise<T> {
    const tail = this.writeQueues.get(projectId) ?? Promise.resolve();
    const run = tail.then(write, write);
    const guard = run.catch(() => {});
    this.writeQueues.set(projectId, guard);
    try {
      return await run;
    } finally {
      // Drop the queue entry only when nothing newer chained behind it.
      if (this.writeQueues.get(projectId) === guard) {
        this.writeQueues.delete(projectId);
      }
    }
  }

  private filePathFor(projectId: string): string {
    const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safeProjectId || safeProjectId !== projectId) {
      throw new Error(`Invalid project id: ${projectId}`);
    }
    return path.join(this.paseoHome, "projects", safeProjectId, "shared-context.json");
  }

  private async loadFile(
    projectId: string,
  ): Promise<{ version: 1; entries: SharedContextEntry[] }> {
    const filePath = this.filePathFor(projectId);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, entries: [] };
      }
      throw error;
    }
    try {
      return SharedContextFileSchema.parse(JSON.parse(raw));
    } catch (error) {
      this.logger.warn(
        { err: error, projectId, filePath },
        "Failed to parse shared context file; treating as empty",
      );
      return { version: 1, entries: [] };
    }
  }
}

function formatDigestEntry(entry: SharedContextEntry): string {
  const author = entry.authorLabel?.trim() || "agent";
  const date = entry.createdAt.slice(0, 10);
  return [`[${entry.kind}] ${entry.title} (${author}, ${date})`, entry.body].join("\n");
}
