import type { UsageInput } from "../shared/input.js";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageAccount,
  type UsageReport,
} from "@getpaseo/plugin/server/usage";

const execFileAsync = promisify(execFile);

const BUDGET_URL = "https://api.mistral.ai/v1/billing/budget";
const API_KEY_ENV = "MISTRAL_API_KEY";
// Vibe stores its login under this service, with the env var name as the account.
const KEYCHAIN_SERVICE = "ai.mistral.vibe";
const KEYCHAIN_TIMEOUT_MS = 2_000;

const BudgetResponseSchema = z.object({
  vibe_budget: z.object({
    usage_percentage: z.number().finite(),
    reset_at: z.string().nullish(),
    payg_enabled: z.boolean().optional(),
  }),
});

function vibeHome(): string {
  return process.env["VIBE_HOME"] || join(homedir(), ".vibe");
}

function parseDotenvValue(content: string, name: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] !== name) continue;
    const value = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
    return value || undefined;
  }
  return undefined;
}

async function readApiKey(input: UsageInput): Promise<string | undefined> {
  if (input.store === "env") return process.env[input.locator] || undefined;
  if (input.store === "dotenv") {
    try {
      return parseDotenvValue(await fs.readFile(input.locator, "utf8"), API_KEY_ENV);
    } catch {
      return undefined;
    }
  }
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-a", API_KEY_ENV, "-w", "-s", input.locator],
      { timeout: KEYCHAIN_TIMEOUT_MS },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const apiKey = await readApiKey(input);
  if (!apiKey) throw new Error("Mistral Vibe login store no longer exists");

  const res = await fetchApi(BUDGET_URL, {
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    return unavailable({ kind: "rejected", status: res.status, refreshedBy: "vibe" });
  }
  if (!res.ok) throw new Error(`Mistral billing API returned ${res.status}`);

  const { vibe_budget: vibe } = BudgetResponseSchema.parse(await res.json());
  // Mistral's own copy calls this a monthly budget that resets on `reset_at`.
  return {
    status: "available",
    windows: [
      windowFromUsedPct({
        id: "monthly",
        label: "Monthly",
        shortLabel: "mo",
        summary: true,
        utilizationPct: vibe.usage_percentage,
        resetsAt: vibe.reset_at,
        tone: toneFromUsedPct(vibe.usage_percentage),
      }),
    ],
    // Pay as you go is Mistral's name for what the Claude card calls extra usage.
    details:
      vibe.payg_enabled === undefined
        ? []
        : [
            {
              id: "extra_usage",
              label: "Extra usage",
              value: vibe.payg_enabled ? "Enabled" : "Disabled",
            },
          ],
  };
}

/** Same precedence as Vibe: process env, then `$VIBE_HOME/.env`, then the macOS Keychain. */
export async function discover(): Promise<UsageAccount[]> {
  const candidates: UsageInput[] = [
    { store: "env", locator: API_KEY_ENV },
    { store: "dotenv", locator: join(vibeHome(), ".env") },
  ];
  if (process.platform === "darwin") {
    candidates.push({ store: "keychain", locator: KEYCHAIN_SERVICE });
  }
  for (const input of candidates) {
    if (await readApiKey(input)) {
      return [
        {
          key: hashAccountKey(`mistral-vibe:${input.store}:${input.locator}`),
          harness: "Vibe",
          input,
        },
      ];
    }
  }
  return [];
}
