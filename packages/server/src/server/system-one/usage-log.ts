import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SystemOneUsageBucket, SystemOneUsageSummary } from "@getpaseo/protocol/messages";
import type { TypeSafeUsage } from "../browser-tools/jev-client.js";

export type SystemOneUsagePurpose = "browser" | "shadow" | "routing" | "handoff" | "team" | "tool";

const WINDOW_DAYS = 7;
// Shadow mode alone writes a few thousand lines a day; older lines are never shown.
const PRUNE_ABOVE_BYTES = 2 * 1024 * 1024;

interface UsageLine {
  ts: string;
  purpose: SystemOneUsagePurpose;
  inputTokens: number;
  outputTokens: number;
}

function usageFile(paseoHome: string): string {
  return path.join(paseoHome, "system-one", "usage.jsonl");
}

export async function recordSystemOneUsage(
  paseoHome: string,
  purpose: SystemOneUsagePurpose,
  usage: TypeSafeUsage | undefined,
  now: Date = new Date(),
): Promise<void> {
  const line: UsageLine = {
    ts: now.toISOString(),
    purpose,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  };
  const file = usageFile(paseoHome);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(line)}\n`);
}

export async function summarizeSystemOneUsage(
  paseoHome: string,
  now: Date = new Date(),
): Promise<SystemOneUsageSummary> {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const windowStart = new Date(startOfToday);
  windowStart.setDate(windowStart.getDate() - (WINDOW_DAYS - 1));
  const summary: SystemOneUsageSummary = { today: {}, last7Days: {} };
  const file = usageFile(paseoHome);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return summary;
  }
  const kept: string[] = [];
  for (const text of raw.split("\n")) {
    const line = parseLine(text);
    if (!line) continue;
    const at = new Date(line.ts);
    if (at < windowStart) continue;
    kept.push(text);
    addTo(summary.last7Days, line);
    if (at >= startOfToday) addTo(summary.today, line);
  }
  // ponytail: a Jev call landing between read and rewrite is lost from the stats; acceptable for a counter.
  if ((await stat(file)).size > PRUNE_ABOVE_BYTES) {
    await writeFile(file, kept.length > 0 ? `${kept.join("\n")}\n` : "");
  }
  return summary;
}

function addTo(buckets: Record<string, SystemOneUsageBucket>, line: UsageLine): void {
  const bucket = buckets[line.purpose] ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
  bucket.calls += 1;
  bucket.inputTokens += line.inputTokens;
  bucket.outputTokens += line.outputTokens;
  buckets[line.purpose] = bucket;
}

function parseLine(text: string): UsageLine | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<UsageLine>;
    if (
      typeof value.ts !== "string" ||
      typeof value.purpose !== "string" ||
      typeof value.inputTokens !== "number" ||
      typeof value.outputTokens !== "number"
    ) {
      return null;
    }
    return value as UsageLine;
  } catch {
    return null;
  }
}
