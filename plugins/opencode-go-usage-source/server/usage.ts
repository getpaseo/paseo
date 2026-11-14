import { z } from "zod";
import {
  hashAccountKey,
  unavailable,
  type UsageAccount,
  toneFromUsedPct,
  windowFromUsedPct,
  type UsageReport,
} from "@getpaseo/plugin/server/usage";
import type { Input } from "../shared/input.js";
import { defaultStorePaths, readDatabaseLogin, readFileKey } from "./stores.js";
const windowSchema = z.object({
  status: z.enum(["ok", "rate-limited"]),
  percent: z.number().finite(),
  resetsAt: z.iso.datetime(),
});
const responseSchema = z.object({
  usage: z.object({ rolling: windowSchema, weekly: windowSchema, monthly: windowSchema }),
});

export async function discover(paths = defaultStorePaths()): Promise<UsageAccount[]> {
  const login = readDatabaseLogin(paths.database);
  if (login) {
    return login.key
      ? [
          {
            key: hashAccountKey(paths.database),
            input: { store: "database", path: paths.database },
          },
        ]
      : [];
  }
  const key = await readFileKey(paths.file);
  return key
    ? [{ key: hashAccountKey(paths.file), input: { store: "file", path: paths.file } }]
    : [];
}

export async function fetchUsage(
  input: Input,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const apiKey =
    input.store === "database" ? readDatabaseLogin(input.path)?.key : await readFileKey(input.path);
  if (!apiKey) throw new Error("OpenCode Go login store no longer exists");
  const response = await fetchApi("https://opencode.ai/zen/go/v1/usage", {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403)
    return unavailable({ kind: "rejected", status: response.status, refreshedBy: "opencode" });
  if (!response.ok) throw new Error(`OpenCode Go usage API returned ${response.status}`);
  const data = responseSchema.parse(await response.json());
  const windows = (
    [
      // The rolling window's length is not reported, so its percent stands without a name.
      ["rolling", "Rolling", "", data.usage.rolling],
      ["weekly", "Weekly", "wk", data.usage.weekly],
      ["monthly", "Monthly", "mo", data.usage.monthly],
    ] as const
  ).map(([id, label, shortLabel, value]) =>
    windowFromUsedPct({
      id,
      label,
      shortLabel,
      utilizationPct: value.percent,
      resetsAt: value.resetsAt,
      tone: toneFromUsedPct(value.percent),
    }),
  );
  return { status: "available", planLabel: "Go", windows };
}
