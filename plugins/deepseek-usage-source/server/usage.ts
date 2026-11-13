import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type {
  UsageAccount,
  UsageBalance,
  UsageDetail,
  UsageProviderModel,
  UsageReport,
  UsageScope,
} from "@getpaseo/plugin/server/usage";
import { unavailable } from "@getpaseo/plugin/server/usage";
import type { UsageInput } from "../shared/input.js";

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const MODEL_ALIAS_ENV = "PASEO_DEEPSEEK_MODEL_ALIASES";

const BalanceInfoSchema = z.object({
  currency: z.string().min(1),
  total_balance: z.string(),
  granted_balance: z.string(),
  topped_up_balance: z.string(),
});

const BalanceResponseSchema = z.object({
  is_available: z.boolean(),
  balance_infos: z.array(BalanceInfoSchema),
});

type KeyLocator = {
  store: UsageInput["store"];
  locator: string;
} & Record<string, string>;

interface ModelAlias {
  provider: string;
  model: string;
}

function piAuthPath(): string {
  return join(homedir(), ".pi", "agent", "auth.json");
}

async function readPiKey(): Promise<string | null> {
  const path = piAuthPath();
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(await readFile(path, "utf8")) as {
    deepseek?: { key?: unknown };
  };
  return typeof parsed.deepseek?.key === "string" && parsed.deepseek.key.trim()
    ? parsed.deepseek.key.trim()
    : null;
}

async function findKeyLocator(): Promise<KeyLocator | null> {
  if (process.env.DEEPSEEK_API_KEY?.trim()) return { store: "env", locator: "DEEPSEEK_API_KEY" };
  if (existsSync(piAuthPath())) return { store: "file", locator: piAuthPath() };
  return null;
}

async function readApiKey(input: UsageInput): Promise<string | null> {
  if (input.store === "env") return process.env[input.locator]?.trim() || null;
  if (input.locator !== piAuthPath()) return null;
  if (!existsSync(input.locator)) throw new Error("Pi auth file no longer exists");
  return readPiKey();
}

export function parseModelAliases(raw = process.env[MODEL_ALIAS_ENV] ?? ""): ModelAlias[] {
  return raw.split(/[,;]/).flatMap((entry) => {
    const separator = entry.indexOf(":");
    if (separator <= 0) return [];
    const provider = entry.slice(0, separator).trim().toLowerCase();
    const model = entry
      .slice(separator + 1)
      .trim()
      .toLowerCase();
    return provider && model ? [{ provider, model }] : [];
  });
}

function modelContainsDeepSeek(model: UsageProviderModel["models"][number]): boolean {
  return [model.id, model.label, model.description ?? "", ...(model.aliases ?? [])].some((value) =>
    /deepseek/i.test(value),
  );
}

function aliasMatches(alias: ModelAlias, provider: string, model?: string): boolean {
  if (alias.provider !== provider.toLowerCase()) return false;
  return alias.model === "*" || (model !== undefined && alias.model === model.toLowerCase());
}

function sessionSignalsDeepSeek(scope: Extract<UsageScope, { kind: "session" }>): boolean {
  if (/deepseek/i.test(`${scope.provider} ${scope.model ?? ""}`)) return true;
  const relevantEnv = [
    "DEEPSEEK_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
  ];
  return relevantEnv.some((name) => /deepseek/i.test(scope.env[name] ?? ""));
}

export function providerSnapshotShowsDeepSeek(
  scope: Extract<UsageScope, { kind: "global" }>,
  aliases = parseModelAliases(),
): boolean {
  return (scope.providers ?? []).some(
    (provider) =>
      provider.models.some(modelContainsDeepSeek) ||
      provider.models.some((model) =>
        aliases.some((alias) => aliasMatches(alias, provider.provider, model.id)),
      ) ||
      aliases.some((alias) => aliasMatches(alias, provider.provider, "*")),
  );
}

export function scopeShowsDeepSeek(scope: UsageScope, aliases = parseModelAliases()): boolean {
  if (scope.kind === "global") return providerSnapshotShowsDeepSeek(scope, aliases);
  return (
    sessionSignalsDeepSeek(scope) ||
    aliases.some((alias) => aliasMatches(alias, scope.provider, scope.model))
  );
}

export async function discover(scope: UsageScope): Promise<UsageAccount[]> {
  if (!scopeShowsDeepSeek(scope)) return [];
  const input = await findKeyLocator();
  if (!input) return [];
  return [{ key: "default", label: "DeepSeek API", input }];
}

function currencySymbol(currency: string): string {
  if (currency === "CNY") return "¥";
  if (currency === "USD") return "$";
  return `${currency} `;
}

function balanceReport(payload: unknown): UsageReport {
  const response = BalanceResponseSchema.parse(payload);
  if (!response.is_available) {
    return unavailable({ kind: "no_quota", detail: "DeepSeek balance is insufficient" });
  }

  const details: UsageDetail[] = [];
  const balances: UsageBalance[] = [];
  for (const balance of response.balance_infos) {
    const currency = balance.currency.toUpperCase();
    const symbol = currencySymbol(currency);
    const id = currency.toLowerCase();
    details.push(
      {
        id: `${id}_total`,
        label: `${currency} total`,
        value: `${symbol}${balance.total_balance}`,
      },
      {
        id: `${id}_topped_up`,
        label: `${currency} topped up`,
        value: `${symbol}${balance.topped_up_balance}`,
      },
      {
        id: `${id}_granted`,
        label: `${currency} granted`,
        value: `${symbol}${balance.granted_balance}`,
      },
    );
    if (currency === "USD") {
      const remaining = Number(balance.total_balance);
      if (Number.isFinite(remaining)) {
        balances.push({
          id: "usd_balance",
          label: "USD balance",
          remaining,
          unit: "usd",
        });
      }
    }
  }

  return {
    status: "available",
    planLabel: "API balance",
    windows: [],
    balances,
    details,
  };
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const key = await readApiKey(input);
  if (!key) throw new Error("DeepSeek API key is no longer available");

  const res = await fetchApi(DEEPSEEK_BALANCE_URL, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    },
  });
  if (res.status === 401 || res.status === 403)
    return unavailable({ kind: "rejected", status: res.status });
  if (!res.ok) throw new Error(`DeepSeek balance API returned ${res.status}`);
  return balanceReport(await res.json());
}
