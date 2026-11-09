import type { UsageInput } from "../shared/input.js";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  unavailable,
  type UsageAccount,
  type UsageReport,
  type UsageDetail,
} from "@getpaseo/plugin/server/usage";

const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);

const CopilotUsageResponseSchema = z.object({
  copilot_plan: ApiOptionalStringSchema,
  quota_reset_date: ApiOptionalStringSchema,
});

async function readToken(input: UsageInput): Promise<string | undefined> {
  if (input.store === "env") return process.env[input.locator];
  try {
    const raw = await fs.readFile(input.locator, "utf8");
    return raw.match(/oauth_token:\s*["']?([a-zA-Z0-9_-]+)["']?/)?.[1];
  } catch {
    return undefined;
  }
}

export async function discover(): Promise<UsageAccount[]> {
  const candidates: UsageInput[] = ["COPILOT_TOKEN", "GITHUB_TOKEN", "GITHUB_PAT"].map(
    (locator) => ({ store: "env", locator }),
  );
  if (process.env.APPDATA)
    candidates.push({
      store: "file",
      locator: join(process.env.APPDATA, "GitHub CLI", "hosts.yml"),
    });
  candidates.push({ store: "file", locator: join(homedir(), ".config", "gh", "hosts.yml") });
  for (const input of candidates) if (await readToken(input)) return [{ key: "default", input }];
  return [];
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const token = await readToken(input);
  if (!token) throw new Error("Copilot login store no longer exists");

  const res = await fetchApi("https://api.github.com/copilot_internal/user", {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/json",
      "Editor-Version": "vscode/1.96.2",
      "Editor-Plugin-Version": "copilot-chat/0.26.7",
      "User-Agent": "GitHubCopilotChat/0.26.7",
      "X-Github-Api-Version": "2025-04-01",
    },
  });

  if (res.status === 401 || res.status === 403)
    return unavailable({ kind: "rejected", status: res.status });
  if (!res.ok) throw new Error(`Copilot usage API returned ${res.status}`);

  const resp = CopilotUsageResponseSchema.parse(await res.json());
  const details: UsageDetail[] = resp.quota_reset_date
    ? [{ id: "reset", label: "Quota reset", value: resp.quota_reset_date }]
    : [];

  return {
    status: "available",
    planLabel: resp.copilot_plan || undefined,
    windows: [],
    balances: [],
    details,
  };
}
