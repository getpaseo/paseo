import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import MarkdownIt from "markdown-it";
import { TaskArtifactSchema, type TaskArtifact } from "@getpaseo/protocol/messages";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";

const queues = new Map<string, Promise<unknown>>();
const recordSchema = z.object({
  items: z.array(TaskArtifactSchema),
  hiddenPaths: z.array(z.string()),
});
const persistedSchema = z.union([
  recordSchema,
  z.array(TaskArtifactSchema).transform((items) => ({ items, hiddenPaths: [] as string[] })),
]);
type ArtifactRecord = z.infer<typeof recordSchema>;
const markdown = new MarkdownIt({ html: false, linkify: false });
const validateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = (href) => /^file:/i.test(href) || validateLink(href);

export function extractArtifactPaths(timeline: readonly AgentTimelineItem[]): string[] {
  const paths = new Set<string>();
  const add = (raw: string | null) => {
    if (!raw) return;
    let value = raw
      .trim()
      .replace(/[#?].*$/, "")
      .replace(/:\d+(?::\d+)?$/, "");
    if (/^file:/i.test(value)) {
      try {
        const url = new URL(value);
        if (url.hostname && url.hostname !== "localhost") return;
        value = url.pathname;
      } catch {
        return;
      }
    } else if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//")) return;
    try {
      value = decodeURIComponent(value);
    } catch {
      /* Keep literal percent filenames. */
    }
    if (value && value.length <= 4096 && !value.includes("\0")) paths.add(value);
  };
  for (const item of timeline) {
    if (item.type !== "assistant_message") continue;
    for (const block of markdown.parse(item.text, {})) {
      for (const token of block.children ?? []) {
        if (token.type === "link_open") add(token.attrGet("href"));
        if (token.type === "image") add(token.attrGet("src"));
        if (
          token.type === "code_inline" &&
          /(?:[/\\]|\.[a-z\d]{1,12}(?:#.*)?$)/i.test(token.content)
        )
          add(token.content);
      }
    }
  }
  return [...paths];
}

export class TaskArtifactStore {
  constructor(private readonly home: string) {}
  private file(agentId: string) {
    return path.join(
      this.home,
      "task-artifacts",
      `${createHash("sha256").update(agentId).digest("hex")}.json`,
    );
  }
  private async read(agentId: string): Promise<ArtifactRecord> {
    try {
      return persistedSchema.parse(JSON.parse(await readFile(this.file(agentId), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [], hiddenPaths: [] };
      throw error;
    }
  }
  private async write(agentId: string, record: ArtifactRecord): Promise<void> {
    const file = this.file(agentId);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, file);
  }
  private async mutate(agentId: string, action: () => Promise<void>): Promise<void> {
    const file = this.file(agentId);
    const previous = queues.get(file) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(action);
    queues.set(file, operation);
    try {
      await operation;
    } finally {
      if (queues.get(file) === operation) queues.delete(file);
    }
  }
  async discover(
    agentId: string,
    cwd: string,
    timeline: readonly AgentTimelineItem[],
  ): Promise<TaskArtifact[]> {
    const candidates = extractArtifactPaths(timeline);
    await this.mutate(agentId, async () => {
      const record = await this.read(agentId);
      const known = new Set([...record.items.map((item) => item.path), ...record.hiddenPaths]);
      let changed = false;
      for (const candidate of candidates) {
        if (record.items.length >= 200) break;
        const normalized = path.relative(cwd, path.resolve(cwd, candidate));
        if (known.has(normalized)) continue;
        let full: string;
        try {
          full = await resolveArtifactPath(cwd, candidate);
        } catch {
          continue;
        }
        const info = await stat(full);
        record.items.push({
          id: randomUUID(),
          path: normalized,
          name: path.basename(full),
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
          addedAt: new Date().toISOString(),
          status: "ready",
        });
        known.add(normalized);
        changed = true;
      }
      if (changed) await this.write(agentId, record);
    });
    return this.list(agentId, cwd);
  }
  async list(agentId: string, cwd: string): Promise<TaskArtifact[]> {
    const { items: entries } = await this.read(agentId);
    return Promise.all(
      entries.map(async (item) => {
        try {
          const full = await resolveArtifactPath(cwd, item.path);
          const info = await stat(full);
          item.status =
            info.size === item.size && info.mtime.toISOString() === item.modifiedAt
              ? "ready"
              : "changed";
          return item;
        } catch {
          item.status = "missing";
          return item;
        }
      }),
    );
  }
  async update(
    agentId: string,
    cwd: string,
    action: "add" | "remove",
    requestedPath: string,
  ): Promise<TaskArtifact[]> {
    await this.mutate(agentId, async () => {
      const record = await this.read(agentId);
      const normalized = path.relative(cwd, path.resolve(cwd, requestedPath));
      const entries = record.items.filter((item) => item.path !== normalized);
      const hidden = new Set(record.hiddenPaths);
      if (action === "add") {
        const full = await resolveArtifactPath(cwd, requestedPath);
        const info = await stat(full);
        if (entries.length >= 200) throw new Error("This task already has 200 artifacts");
        entries.push({
          id: randomUUID(),
          path: normalized,
          name: path.basename(full),
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
          addedAt: new Date().toISOString(),
          status: "ready",
        });
        hidden.delete(normalized);
      } else {
        hidden.add(normalized);
      }
      await this.write(agentId, { items: entries, hiddenPaths: [...hidden] });
    });
    return this.list(agentId, cwd);
  }
}
export async function resolveArtifactPath(cwd: string, requested: string) {
  const root = await realpath(cwd);
  const full = await realpath(path.resolve(root, requested));
  if (full !== root && !full.startsWith(root + path.sep))
    throw new Error("Task artifacts must be inside this task's workspace");
  if (!(await stat(full)).isFile()) throw new Error("Choose a regular file");
  return full;
}
