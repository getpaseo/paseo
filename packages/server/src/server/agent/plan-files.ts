import path from "node:path";
import fs from "node:fs/promises";
import type { AgentTimelineItem, ToolCallTimelineItem } from "./agent-sdk-types.js";

const PLAN_FILE_EXTENSIONS = new Set([".md", ".markdown"]);
const PLAN_DIRECTORIES = new Set(["/.paseo/plans/", "/.opencode/plans/"]);

export function isPlanFilePath(filePath: string): boolean {
  const normalized = normalizePlanPath(filePath);
  const ext = path.posix.extname(normalized).toLowerCase();
  if (!PLAN_FILE_EXTENSIONS.has(ext)) {
    return false;
  }
  const searchable = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return Array.from(PLAN_DIRECTORIES).some((dir) => searchable.includes(dir));
}

export async function planItemFromToolCall(params: {
  item: ToolCallTimelineItem;
  cwd: string;
  homeDir: string;
}): Promise<AgentTimelineItem | null> {
  const { item, cwd, homeDir } = params;
  if (item.status !== "completed") {
    return null;
  }
  const detail = item.detail;
  if (detail.type !== "write" && detail.type !== "edit") {
    return null;
  }
  if (!isPlanFilePath(detail.filePath)) {
    return null;
  }

  const explicitContent = detail.type === "write" ? detail.content : undefined;
  const text = explicitContent ?? (await readPlanFile(detail.filePath, cwd, homeDir));
  if (!text?.trim()) {
    return null;
  }

  return {
    type: "plan",
    planId: `plan-file:${normalizePlanPath(detail.filePath)}`,
    text: text.trim(),
  };
}

function normalizePlanPath(filePath: string): string {
  return path.posix.normalize(filePath.replace(/\\/g, "/"));
}

async function readPlanFile(
  filePath: string,
  cwd: string,
  homeDir: string,
): Promise<string | null> {
  const candidates = path.isAbsolute(filePath)
    ? [filePath]
    : [path.resolve(cwd, filePath), path.resolve(homeDir, filePath)];

  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, "utf8");
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}
