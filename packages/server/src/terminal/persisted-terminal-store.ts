import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { writeJsonFileAtomic } from "../server/atomic-file.js";

export const PersistedTerminalAgentSessionSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  sessionId: z.string().min(1).max(256),
  // The agent's working directory when it reported the session. Claude keys
  // sessions by project directory, so resume has to start there.
  cwd: z.string().min(1).optional(),
});

export const PersistedTerminalSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  cwd: z.string().min(1),
  name: z.string(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  agentSession: PersistedTerminalAgentSessionSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PersistedTerminal = z.infer<typeof PersistedTerminalSchema>;
export type PersistedTerminalAgentSession = z.infer<typeof PersistedTerminalAgentSessionSchema>;

const TERMINAL_ID_FILE_NAME = /^[A-Za-z0-9_-]+$/;

// One file per terminal under `$PASEO_HOME/terminals/`. Writes and deletes for the
// same terminal are serialized so a late write cannot resurrect a closed terminal.
// `clear()` is a barrier across all terminals: writes requested before it never
// land after it, and mutations requested during it run once it is done.
export class PersistedTerminalStore {
  private readonly mutations = new Map<string, Promise<unknown>>();
  private generation = 0;
  private clearing: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {}

  async list(): Promise<PersistedTerminal[]> {
    const records: PersistedTerminal[] = [];
    for (const name of await this.recordFileNames()) {
      const filePath = join(this.dir, name);
      // One unreadable or vanished record must not keep the others from restoring.
      const content = await readFile(filePath, "utf-8").catch((error: unknown) => {
        this.logger.warn({ err: error, filePath }, "Skipping unreadable terminal record");
        return null;
      });
      if (content === null) continue;
      const parsed = parsePersistedTerminal(content);
      if (parsed.success) {
        records.push(parsed.data);
      } else {
        this.logger.warn({ err: parsed.error, filePath }, "Skipping invalid terminal record");
      }
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async put(record: PersistedTerminal): Promise<void> {
    const filePath = this.filePath(record.id);
    const generation = this.generation;
    await this.serialize(record.id, async () => {
      if (generation !== this.generation) return;
      await writeJsonFileAtomic(filePath, record);
    });
  }

  async delete(id: string): Promise<void> {
    const filePath = this.filePath(id);
    await this.serialize(id, () => rm(filePath, { force: true }));
  }

  async clear(): Promise<void> {
    this.generation += 1;
    const inFlight = Array.from(this.mutations.values());
    const previous = this.clearing;
    const cleared = (async () => {
      await previous;
      await Promise.allSettled(inFlight);
      const names = await this.recordFileNames();
      await Promise.all(names.map((name) => rm(join(this.dir, name), { force: true })));
    })();
    this.clearing = cleared.catch(() => undefined);
    await cleared;
  }

  private async recordFileNames(): Promise<string[]> {
    const entries = await readdir(this.dir, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
  }

  private filePath(id: string): string {
    if (!TERMINAL_ID_FILE_NAME.test(id)) {
      throw new Error(`Invalid terminal id for persistence: ${id}`);
    }
    return join(this.dir, `${id}.json`);
  }

  private async serialize<T>(id: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(id) ?? Promise.resolve();
    const next = Promise.all([previous.catch(() => undefined), this.clearing]).then(mutation);
    this.mutations.set(id, next);
    try {
      return await next;
    } finally {
      if (this.mutations.get(id) === next) {
        this.mutations.delete(id);
      }
    }
  }
}

function parsePersistedTerminal(
  content: string,
): { success: true; data: PersistedTerminal } | { success: false; error: unknown } {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    return { success: false, error };
  }
  return PersistedTerminalSchema.safeParse(json);
}
