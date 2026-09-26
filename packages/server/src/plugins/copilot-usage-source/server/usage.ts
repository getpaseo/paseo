import type { UsageInput } from "../shared/input.js";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  unavailableUsage,
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

async function readGithubCliToken(): Promise<string | null> {
  const candidates: string[] = [];
  if (process.env["APPDATA"]) {
    candidates.push(join(process.env["APPDATA"], "GitHub CLI", "hosts.yml"));
  }
  candidates.push(join(homedir(), ".config", "gh", "hosts.yml"));

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = await fs.readFile(path, "utf8");
      const match = raw.match(/oauth_token:\s*["']?([a-zA-Z0-9_-]+)["']?/);
      if (match?.[1]) return match[1];
    } catch {
      continue;
    }
  }
  return null;
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  void input;

  const token =
    process.env["COPILOT_TOKEN"] ||
    process.env["GITHUB_TOKEN"] ||
    process.env["GITHUB_PAT"] ||
    (await readGithubCliToken());

  if (!token) return unavailableUsage();

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

  if (!res.ok) {
    return unavailableUsage();
  }

  const resp = CopilotUsageResponseSchema.parse(await res.json());
  const details: UsageDetail[] = resp.quota_reset_date
    ? [{ id: "reset", label: "Quota reset", value: resp.quota_reset_date }]
    : [];

  return {
    account: { key: "default" },
    status: "available",
    planLabel: resp.copilot_plan || undefined,
    windows: [],
    balances: [],
    details,
  };
}
