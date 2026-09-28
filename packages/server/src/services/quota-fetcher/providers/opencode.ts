import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage, ProviderUsageWindow } from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNumberSchema,
  ApiOptionalStringSchema,
  fetchProviderApi,
  toneFromUsedPct,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";

// OpenCode Go is a subscription with three stacked dollar caps: $12 per rolling
// 5 hours, $30 per week, $60 per month. The account-wide usage lives at the
// official endpoint, authenticated by the `opencode-go` API key OpenCode writes
// to auth.json — the same key its own dashboard reads. The local opencode.db only
// sees usage from this machine, so it drifts from the dashboard; don't use it here.
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_AUTH_RELATIVE_PATH = join(".local", "share", "opencode", "auth.json");
const OPENCODE_GO_AUTH_KEY = "opencode-go";
const OPENCODE_GO_PLAN_LABEL = "$12 / 5h · $30 / week · $60 / month";

const OpenCodeGoWindowSchema = z.object({
  status: ApiOptionalStringSchema,
  percent: ApiNumberSchema.nullable().optional(),
  resetsAt: ApiOptionalStringSchema,
});

const OpenCodeGoUsageResponseSchema = z.object({
  usage: z.object({
    rolling: OpenCodeGoWindowSchema.nullable().optional(),
    weekly: OpenCodeGoWindowSchema.nullable().optional(),
    monthly: OpenCodeGoWindowSchema.nullable().optional(),
  }),
});

type OpenCodeGoWindow = z.infer<typeof OpenCodeGoWindowSchema>;

interface OpenCodeQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

function openCodeAuthPaths(homeDir: string, env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = [];
  const xdgDataHome = env["XDG_DATA_HOME"]?.trim();
  if (xdgDataHome) paths.push(join(xdgDataHome, "opencode", "auth.json"));
  paths.push(join(homeDir, OPENCODE_AUTH_RELATIVE_PATH));
  const localAppData = env["LOCALAPPDATA"]?.trim();
  if (localAppData) paths.push(join(localAppData, "opencode", "auth.json"));
  return paths;
}

function usageWindow(input: {
  id: string;
  label: string;
  window: OpenCodeGoWindow | null | undefined;
}): ProviderUsageWindow | null {
  const percent = input.window?.percent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  return windowFromUsedPct({
    id: input.id,
    label: input.label,
    utilizationPct: percent,
    resetsAt: input.window?.resetsAt ?? null,
    tone: toneFromUsedPct(percent),
  });
}

export class OpenCodeQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "opencode";
  readonly displayName = "OpenCode Go";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly homeDir: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: OpenCodeQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.homeDir = options.homeDir ?? homedir();
    this.env = options.env ?? process.env;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const apiKey = await this.resolveApiKey();
    if (!apiKey) return unavailableUsage(this);

    const res = await fetchProviderApi(this.fetchApi, OPENCODE_GO_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "OpenCode Go usage fetch failed");
      return unavailableUsage(this);
    }

    const resp = OpenCodeGoUsageResponseSchema.parse(await res.json());
    const windows = [
      usageWindow({ id: "rolling", label: "5-hour", window: resp.usage.rolling }),
      usageWindow({ id: "weekly", label: "Weekly", window: resp.usage.weekly }),
      usageWindow({ id: "monthly", label: "Monthly", window: resp.usage.monthly }),
    ].filter((window): window is ProviderUsageWindow => window !== null);

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: windows.length > 0 ? "available" : "unavailable",
      planLabel: windows.length > 0 ? OPENCODE_GO_PLAN_LABEL : null,
      sourceLabel: "OpenCode Go",
      windows,
      balances: [],
      details: [],
      error: null,
    };
  }

  private async resolveApiKey(): Promise<string | null> {
    const envKey = this.env["OPENCODE_GO_API_KEY"]?.trim();
    if (envKey) return envKey;

    for (const authPath of openCodeAuthPaths(this.homeDir, this.env)) {
      if (!existsSync(authPath)) continue;
      try {
        const raw = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
        const entry = raw[OPENCODE_GO_AUTH_KEY];
        if (entry && typeof entry === "object") {
          const key = (entry as { key?: unknown }).key;
          if (typeof key === "string" && key.trim()) return key.trim();
        }
      } catch (err) {
        // Locked/corrupt/malformed auth.json all land here; log so an unavailable
        // OpenCode card is diagnosable, then try the next candidate.
        this.logger.debug({ err, path: authPath }, "Failed to read OpenCode credentials");
      }
    }
    return null;
  }
}
