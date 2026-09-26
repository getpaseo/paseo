import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  toneFromUsedPct,
  windowFromUsedPct,
  type UsageReport,
} from "@getpaseo/plugin/server/usage";
import type { Input } from "../shared/input.js";

const authSchema = z
  .object({
    "opencode-go": z
      .object({ type: z.literal("api"), key: z.string().min(1) })
      .passthrough()
      .optional(),
  })
  .passthrough();
const windowSchema = z.object({
  status: z.enum(["ok", "rate-limited"]),
  percent: z.number().finite(),
  resetsAt: z.iso.datetime(),
});
const responseSchema = z.object({
  usage: z.object({ rolling: windowSchema, weekly: windowSchema, monthly: windowSchema }),
});

function authPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"),
    "opencode",
    "auth.json",
  );
}

async function readDefaultKey(path = authPath()): Promise<string | null> {
  try {
    const auth = authSchema.parse(JSON.parse(await readFile(path, "utf8")));
    return auth["opencode-go"]?.key ?? null;
  } catch {
    return null;
  }
}

export async function discover(path = authPath()): Promise<Array<{}>> {
  return (await readDefaultKey(path)) ? [{}] : [];
}

export async function fetchUsage(
  input: Input,
  fetchApi: typeof fetch = fetch,
  path = authPath(),
): Promise<UsageReport> {
  const apiKey = "apiKey" in input ? input.apiKey : await readDefaultKey(path);
  if (!apiKey) return { account: { key: "default" }, status: "unavailable", windows: [] };
  const key = createHash("sha256").update(apiKey).digest("hex");
  const response = await fetchApi("https://opencode.ai/zen/go/v1/usage", {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403)
    return { account: { key }, status: "unavailable", windows: [] };
  if (!response.ok) throw new Error(`OpenCode Go usage API returned ${response.status}`);
  const data = responseSchema.parse(await response.json());
  const windows = (
    [
      ["rolling", "Rolling", data.usage.rolling],
      ["weekly", "Weekly", data.usage.weekly],
      ["monthly", "Monthly", data.usage.monthly],
    ] as const
  ).map(([id, label, value]) =>
    windowFromUsedPct({
      id,
      label,
      utilizationPct: value.percent,
      resetsAt: value.resetsAt,
      tone: toneFromUsedPct(value.percent),
      headline: id === "rolling",
    }),
  );
  return { account: { key }, status: "available", planLabel: "Go", windows };
}
