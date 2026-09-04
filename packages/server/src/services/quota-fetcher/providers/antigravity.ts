import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageWindow,
} from "../../../server/messages.js";
import type { ProviderUsageFetcher } from "../provider.js";
import {
  balanceToneFromRemaining,
  toneFromUsedPct,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";

const execFileAsync = promisify(execFile);

const GET_USER_STATUS_PATH =
  "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const GET_UNLEASH_DATA_PATH =
  "/exa.language_server_pb.LanguageServerService/GetUnleashData";
const RPC_TIMEOUT_MS = 8_000;

export interface LanguageServerInfo {
  pid: number;
  csrfToken: string;
}

export interface ApiEndpoint {
  port: number;
  tls: boolean;
}

export interface RpcResult {
  status: number;
  body: string;
}

interface AntigravityQuotaProviderOptions {
  logger: Logger;
  findLanguageServer?: () => Promise<LanguageServerInfo | null>;
  listListeningPorts?: (pid: number) => Promise<number[]>;
  rpc?: (
    endpoint: ApiEndpoint,
    csrfToken: string,
    path: string,
  ) => Promise<RpcResult>;
}

interface ModelQuota {
  modelId: string;
  label: string;
  remainingFraction: number;
  resetTime: string | null;
}

interface QuotaData {
  planLabel: string | null;
  tier: string | null;
  monthlyPromptCredits: number | null;
  availablePromptCredits: number | null;
  availableFlowCredits: number | null;
  models: ModelQuota[];
}

/** Locate the running Antigravity language server process (CLI or IDE). */
export async function defaultFindLanguageServer(): Promise<LanguageServerInfo | null> {
  let stdout: string;
  try {
    const { stdout: out } = await execFileAsync("ps", ["-ww", "-eo", "pid,ppid,args"]);
    stdout = out;
  } catch {
    return null;
  }
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    if (!Number.isInteger(pid)) continue;
    const cmd = parts.slice(2).join(" ");
    if (!/language_server/.test(cmd)) continue;
    if (!/--app_data_dir[=\s]+antigravity\b/.test(cmd)) continue;
    const tokenMatch = cmd.match(/--csrf_token[=\s]+([a-zA-Z0-9-]+)/);
    if (!tokenMatch) continue;
    return { pid, csrfToken: tokenMatch[1] };
  }
  return null;
}

/** List TCP listen ports for a process via lsof, falling back to ss. */
export async function defaultListListeningPorts(pid: number): Promise<number[]> {
  const ports = new Set<number>();
  try {
    const { stdout } = await execFileAsync("lsof", [
      "-nP",
      "-a",
      "-iTCP",
      "-sTCP:LISTEN",
      "-p",
      String(pid),
    ]);
    for (const line of stdout.split("\n")) {
      const m = line.match(/127\.0\.0\.1:(\d+)/);
      if (m) ports.add(Number(m[1]));
    }
  } catch {
    // lsof unavailable; fall back to ss below
  }
  if (ports.size === 0) {
    try {
      const { stdout } = await execFileAsync("ss", ["-tlnp"]);
      for (const line of stdout.split("\n")) {
        if (!line.includes(`pid=${pid}`)) continue;
        const m = line.match(/:(\d+)\s/);
        if (m) ports.add(Number(m[1]));
      }
    } catch {
      // ignore
    }
  }
  return [...ports];
}

/** POST a JSON-RPC-style request to the local language server. */
export async function defaultRpc(
  endpoint: ApiEndpoint,
  csrfToken: string,
  path: string,
): Promise<RpcResult> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      metadata: { ideName: "antigravity", extensionName: "antigravity", locale: "en" },
    });
    const options: RequestOptions = {
      hostname: "127.0.0.1",
      port: endpoint.port,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Connect-Protocol-Version": "1",
        "X-Codeium-Csrf-Token": csrfToken,
      },
    };
    const reqFn = endpoint.tls ? httpsRequest : httpRequest;
    if (endpoint.tls) {
      options.rejectUnauthorized = false;
    }
    const req = reqFn(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.setTimeout(RPC_TIMEOUT_MS, () => req.destroy());
    req.write(payload);
    req.end();
  });
}

export function parseUserStatus(raw: unknown): QuotaData | null {
  if (!raw || typeof raw !== "object") return null;
  const us = (raw as { userStatus?: unknown }).userStatus;
  if (!us || typeof us !== "object") return null;
  const record = us as Record<string, unknown>;
  const planStatus = (record.planStatus ?? {}) as Record<string, unknown>;
  const planInfo = (planStatus.planInfo ?? {}) as Record<string, unknown>;
  const cascade = (record.cascadeModelConfigData ?? {}) as Record<string, unknown>;
  const configs = Array.isArray(cascade.clientModelConfigs)
    ? (cascade.clientModelConfigs as Array<Record<string, unknown>>)
    : [];

  const toNum = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const models: ModelQuota[] = [];
  for (const m of configs) {
    const quotaInfo = (m.quotaInfo ?? {}) as Record<string, unknown>;
    if (typeof quotaInfo.remainingFraction !== "number") continue;
    const modelOrAlias = (m.modelOrAlias ?? {}) as Record<string, unknown>;
    models.push({
      modelId: typeof modelOrAlias.model === "string" ? modelOrAlias.model : "unknown",
      label: typeof m.label === "string" ? m.label : "Unknown model",
      remainingFraction: quotaInfo.remainingFraction,
      resetTime: typeof quotaInfo.resetTime === "string" ? quotaInfo.resetTime : null,
    });
  }

  return {
    planLabel: typeof planInfo.planName === "string" ? planInfo.planName : null,
    tier: typeof planInfo.teamsTier === "string" ? planInfo.teamsTier : null,
    monthlyPromptCredits: toNum(planInfo.monthlyPromptCredits),
    availablePromptCredits: toNum(planStatus.availablePromptCredits),
    availableFlowCredits: toNum(planStatus.availableFlowCredits),
    models,
  };
}

export function buildProviderUsage(quota: QuotaData): ProviderUsage {
  const windows: ProviderUsageWindow[] = [];
  const details: ProviderUsage["details"] = [];

  let constrained: ModelQuota | null = null;
  for (const m of quota.models) {
    const usedPct = Math.round((1 - m.remainingFraction) * 10_000) / 100;
    details?.push({
      id: `model_${m.modelId}`,
      label: m.label,
      value: `${Math.round(m.remainingFraction * 100)}% left` +
        (m.resetTime ? ` (resets ${m.resetTime})` : ""),
      tone: toneFromUsedPct(usedPct),
    });
    if (!constrained || m.remainingFraction < constrained.remainingFraction) {
      constrained = m;
    }
  }

  if (constrained) {
    const usedPct = Math.round((1 - constrained.remainingFraction) * 10_000) / 100;
    windows.push(
      windowFromUsedPct({
        id: "daily_request_quota",
        label: "Daily request quota",
        utilizationPct: usedPct,
        resetsAt: constrained.resetTime,
        tone: toneFromUsedPct(usedPct),
      }),
    );
  }

  const balances: ProviderUsageBalance[] = [];
  if (quota.monthlyPromptCredits !== null && quota.availablePromptCredits !== null) {
    const used = Math.max(0, quota.monthlyPromptCredits - quota.availablePromptCredits);
    balances.push({
      id: "prompt_credits",
      label: "Monthly prompt credits",
      used,
      remaining: quota.availablePromptCredits,
      limit: quota.monthlyPromptCredits,
      unit: "credits",
      resetsAt: null,
      tone: balanceToneFromRemaining(quota.availablePromptCredits),
    });
  } else if (quota.availablePromptCredits !== null) {
    balances.push({
      id: "prompt_credits",
      label: "Prompt credits",
      remaining: quota.availablePromptCredits,
      unit: "credits",
      tone: balanceToneFromRemaining(quota.availablePromptCredits),
    });
  }
  if (quota.availableFlowCredits !== null) {
    balances.push({
      id: "flow_credits",
      label: "Flow credits",
      remaining: quota.availableFlowCredits,
      unit: "credits",
      tone: balanceToneFromRemaining(quota.availableFlowCredits),
    });
  }

  const planLabel = [quota.planLabel, quota.tier].filter(Boolean).join(" · ") || null;

  return {
    providerId: "antigravity",
    displayName: "Antigravity",
    status: "available",
    planLabel,
    sourceLabel: "Antigravity language server",
    windows,
    balances,
    details,
  };
}

export class AntigravityQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "antigravity";
  readonly displayName = "Antigravity";

  private readonly logger: Logger;
  private readonly findLanguageServer: () => Promise<LanguageServerInfo | null>;
  private readonly listListeningPorts: (pid: number) => Promise<number[]>;
  private readonly rpc: (
    endpoint: ApiEndpoint,
    csrfToken: string,
    path: string,
  ) => Promise<RpcResult>;

  constructor(options: AntigravityQuotaProviderOptions) {
    this.logger = options.logger.child({ module: "antigravity-quota-provider" });
    this.findLanguageServer = options.findLanguageServer ?? defaultFindLanguageServer;
    this.listListeningPorts = options.listListeningPorts ?? defaultListListeningPorts;
    this.rpc = options.rpc ?? defaultRpc;
  }

  private async findApiPort(server: LanguageServerInfo): Promise<ApiEndpoint | null> {
    const ports = await this.listListeningPorts(server.pid);
    for (const port of ports) {
      for (const tls of [true, false]) {
        const result = await this.rpc({ port, tls }, server.csrfToken, GET_UNLEASH_DATA_PATH);
        if (result.status === 200) {
          return { port, tls };
        }
      }
    }
    return null;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const server = await this.findLanguageServer();
    if (!server) {
      this.logger.debug("Antigravity language server not found");
      return unavailableUsage(this);
    }
    const api = await this.findApiPort(server);
    if (!api) {
      this.logger.debug("Antigravity API port not found");
      return unavailableUsage(this);
    }
    const result = await this.rpc(api, server.csrfToken, GET_USER_STATUS_PATH);
    if (result.status !== 200) {
      this.logger.debug({ status: result.status }, "GetUserStatus failed");
      return unavailableUsage(this);
    }
    let quota: QuotaData | null;
    try {
      quota = parseUserStatus(JSON.parse(result.body));
    } catch (error) {
      this.logger.debug({ err: error }, "Failed to parse GetUserStatus");
      return unavailableUsage(this);
    }
    if (!quota) {
      return unavailableUsage(this);
    }
    return buildProviderUsage(quota);
  }
}
