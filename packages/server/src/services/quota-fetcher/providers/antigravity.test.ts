import { describe, expect, it, vi } from "vitest";
import type { ProviderUsage } from "../../../server/messages.js";
import type { ApiEndpoint, RpcResult } from "./antigravity.js";
import {
  AntigravityQuotaProvider,
  buildProviderUsage,
  parseUserStatus,
} from "./antigravity.js";

function createLogger() {
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger as never;
}

const sampleUserStatus = {
  userStatus: {
    name: "Test User",
    email: "test@example.com",
    planStatus: {
      planInfo: {
        planName: "Pro",
        teamsTier: "TEAMS_TIER_PRO",
        monthlyPromptCredits: 50000,
      },
      availablePromptCredits: 4200,
      availableFlowCredits: 100,
    },
    cascadeModelConfigData: {
      clientModelConfigs: [
        {
          label: "Gemini 3.7 Flash (High)",
          modelOrAlias: { model: "gemini-3.7-flash-high" },
          quotaInfo: { remainingFraction: 0.5, resetTime: "2026-08-24T00:00:00Z" },
        },
        {
          label: "Claude Sonnet 4.6 (Thinking)",
          modelOrAlias: { model: "claude-sonnet-4-6" },
          quotaInfo: { remainingFraction: 0.1, resetTime: "2026-08-24T00:00:00Z" },
        },
      ],
    },
  },
};

function provider(overrides: {
  findLanguageServer?: () => Promise<{ pid: number; csrfToken: string } | null>;
  listListeningPorts?: (pid: number) => Promise<number[]>;
  rpc?: (endpoint: ApiEndpoint, csrfToken: string, path: string) => Promise<RpcResult>;
}) {
  return new AntigravityQuotaProvider({
    logger: createLogger(),
    findLanguageServer: overrides.findLanguageServer,
    listListeningPorts: overrides.listListeningPorts,
    rpc: overrides.rpc,
  });
}

function okRpc(result: RpcResult) {
  return async () => result;
}

describe("AntigravityQuotaProvider", () => {
  it("parses plan and per-model quotas from GetUserStatus", () => {
    const quota = parseUserStatus(sampleUserStatus);
    expect(quota).not.toBeNull();
    expect(quota!.planLabel).toBe("Pro");
    expect(quota!.tier).toBe("TEAMS_TIER_PRO");
    expect(quota!.monthlyPromptCredits).toBe(50000);
    expect(quota!.availablePromptCredits).toBe(4200);
    expect(quota!.availableFlowCredits).toBe(100);
    expect(quota!.models).toHaveLength(2);
    expect(quota!.models[0].remainingFraction).toBe(0.5);
  });

  it("returns null for malformed responses", () => {
    expect(parseUserStatus(null)).toBeNull();
    expect(parseUserStatus({})).toBeNull();
    expect(parseUserStatus({ userStatus: {} })).not.toBeNull();
  });

  it("maps quota into ProviderUsage with balances and most-constrained window", () => {
    const quota = parseUserStatus(sampleUserStatus)!;
    const usage = buildProviderUsage(quota) as ProviderUsage;
    expect(usage.status).toBe("available");
    expect(usage.providerId).toBe("antigravity");
    expect(usage.planLabel).toBe("Pro · TEAMS_TIER_PRO");
    expect(usage.windows).toHaveLength(1);
    // Most constrained model (Claude, 10% left) drives the window.
    expect(usage.windows[0].remainingPct).toBe(10);
    expect(usage.windows[0].label).toBe("Daily request quota");
    expect(usage.windows[0].tone).toBe("warning");
    const credits = usage.balances!.find((b) => b.id === "prompt_credits")!;
    expect(credits.limit).toBe(50000);
    expect(credits.remaining).toBe(4200);
    expect(credits.used).toBe(45800);
    expect(credits.unit).toBe("credits");
    const flow = usage.balances!.find((b) => b.id === "flow_credits")!;
    expect(flow.remaining).toBe(100);
    expect(usage.details).toHaveLength(2);
  });

  it("reports unavailable when no language server is running", async () => {
    const p = provider({ findLanguageServer: async () => null });
    const usage = await p.fetchUsage();
    expect(usage.status).toBe("unavailable");
    expect(usage.windows).toEqual([]);
  });

  it("reports unavailable when no API port is found", async () => {
    const p = provider({
      findLanguageServer: async () => ({ pid: 123, csrfToken: "csrf" }),
      listListeningPorts: async () => [],
    });
    const usage = await p.fetchUsage();
    expect(usage.status).toBe("unavailable");
  });

  it("discovers the API port via GetUnleashData and fetches quota", async () => {
    const rpcCalls: string[] = [];
    const p = provider({
      findLanguageServer: async () => ({ pid: 123, csrfToken: "csrf" }),
      listListeningPorts: async () => [4100, 4200],
      rpc: async (endpoint, csrf, path) => {
        rpcCalls.push(`${endpoint.port}:${path}`);
        if (path.endsWith("GetUnleashData") && endpoint.port === 4200) {
          return { status: 200, body: "{}" };
        }
        if (path.endsWith("GetUserStatus")) {
          return { status: 200, body: JSON.stringify(sampleUserStatus) };
        }
        return { status: 404, body: "" };
      },
    });
    const usage = await p.fetchUsage();
    expect(usage.status).toBe("available");
    expect(usage.planLabel).toContain("Pro");
    expect(usage.balances!.length).toBe(2);
    expect(rpcCalls).toContain("4200:/exa.language_server_pb.LanguageServerService/GetUnleashData");
    expect(rpcCalls).toContain("4200:/exa.language_server_pb.LanguageServerService/GetUserStatus");
  });

  it("returns error status when the RPC fails", async () => {
    const p = provider({
      findLanguageServer: async () => ({ pid: 123, csrfToken: "csrf" }),
      listListeningPorts: async () => [4100],
      rpc: okRpc({ status: 500, body: "boom" }),
    });
    const usage = await p.fetchUsage();
    expect(usage.status).toBe("unavailable");
  });
});
