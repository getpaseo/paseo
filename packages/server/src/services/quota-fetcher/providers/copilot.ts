import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage, ProviderUsageDetail } from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import { ApiOptionalStringSchema, fetchProviderApi, unavailableUsage } from "../usage.js";

const CopilotUsageResponseSchema = z.object({
  copilot_plan: ApiOptionalStringSchema,
  quota_reset_date: ApiOptionalStringSchema,
});

interface CopilotQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
}

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

export class CopilotQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "copilot";
  readonly displayName = "GitHub Copilot";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;

  constructor(options: CopilotQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const token =
      process.env["COPILOT_TOKEN"] ||
      process.env["GITHUB_TOKEN"] ||
      process.env["GITHUB_PAT"] ||
      (await readGithubCliToken());

    if (!token) return unavailableUsage(this);

    const res = await fetchProviderApi(
      this.fetchApi,
      "https://api.github.com/copilot_internal/user",
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/json",
          "Editor-Version": "vscode/1.96.2",
          "Editor-Plugin-Version": "copilot-chat/0.26.7",
          "User-Agent": "GitHubCopilotChat/0.26.7",
          "X-Github-Api-Version": "2025-04-01",
        },
      },
    );

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Copilot usage fetch failed");
      return unavailableUsage(this);
    }

    const resp = CopilotUsageResponseSchema.parse(await res.json());
    const details: ProviderUsageDetail[] = resp.quota_reset_date
      ? [{ id: "reset", label: "Quota reset", value: resp.quota_reset_date }]
      : [];

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: resp.copilot_plan || null,
      windows: [],
      balances: [],
      details,
      error: null,
    };
  }
}
