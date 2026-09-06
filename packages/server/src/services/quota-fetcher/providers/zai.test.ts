import { describe, expect, it, vi } from "vitest";
import type { ProviderUsageAgentProviderConfigs } from "../provider.js";
import { ZaiQuotaProvider } from "./zai.js";

const SESSION_RESET = 1_782_960_937_355;
const WEEKLY_RESET = 1_783_303_263_991;

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function monitorResponse(
  limits: Array<{
    type: string;
    unit?: number | string;
    number?: number | string;
    percentage?: number | string | null;
    nextResetTime?: number | string | null;
  }> = [
    { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 7, nextResetTime: SESSION_RESET },
    { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 84, nextResetTime: WEEKLY_RESET },
    { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 6, nextResetTime: WEEKLY_RESET + 1 },
  ],
  level = "max",
) {
  return { code: 200, success: true, data: { limits, level } };
}

function createProvider(
  options: {
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    providerConfigs?: ProviderUsageAgentProviderConfigs;
  } = {},
) {
  return new ZaiQuotaProvider({
    logger: createLogger(),
    env: options.env ?? {},
    fetch: options.fetch,
    getAgentProviderConfigs: () => options.providerConfigs ?? {},
  });
}

describe("ZaiQuotaProvider", () => {
  it("returns unavailable without a supported credential", async () => {
    const fetchApi = vi.fn();

    await expect(
      createProvider({ fetch: fetchApi as unknown as typeof fetch }).fetchUsage(),
    ).resolves.toMatchObject({ status: "unavailable", windows: [] });
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("maps Z.ai monitor windows by declared duration and preserves subscription metadata", async () => {
    const fetchApi = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/monitor/usage/quota/limit")) {
        expect(init?.headers).toMatchObject({ Authorization: "zai-token" });
        return jsonResponse(
          monitorResponse([
            {
              type: "TOKENS_LIMIT",
              unit: 6,
              number: 1,
              percentage: 84,
              nextResetTime: SESSION_RESET,
            },
            {
              type: "TIME_LIMIT",
              unit: 5,
              number: 1,
              percentage: 6,
              nextResetTime: WEEKLY_RESET + 1,
            },
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              number: 5,
              percentage: 7,
              nextResetTime: WEEKLY_RESET,
            },
          ]),
        );
      }
      if (url.endsWith("/api/biz/subscription/list")) {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer zai-token" });
        return jsonResponse({
          data: [
            {
              productName: "GLM Coding Max",
              status: "VALID",
              purchaseTime: "2026-01-12 16:55:13",
              valid: "2026-02-12 16:55:13-2026-03-12 16:55:13",
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    await expect(
      createProvider({ env: { ZAI_API_KEY: "zai-token" }, fetch: fetchApi }).fetchUsage(),
    ).resolves.toMatchObject({
      status: "available",
      planLabel: "GLM Coding Max",
      windows: [
        {
          id: "session",
          label: "Session (5h)",
          usedPct: 7,
          remainingPct: 93,
          resetsAt: new Date(WEEKLY_RESET).toISOString(),
          tone: "ok",
        },
        {
          id: "weekly",
          label: "Weekly (7d)",
          usedPct: 84,
          remainingPct: 16,
          resetsAt: new Date(SESSION_RESET).toISOString(),
          tone: "warning",
        },
        {
          id: "monthly-tools",
          label: "MCP tools (monthly)",
          usedPct: 6,
          remainingPct: 94,
          resetsAt: new Date(WEEKLY_RESET + 1).toISOString(),
          tone: "ok",
        },
      ],
      details: expect.arrayContaining([{ id: "status", label: "Status", value: "VALID" }]),
    });
  });

  it("uses the GLM China endpoint with a bare GLM_API_KEY", async () => {
    const fetchApi = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
      expect(init?.headers).toMatchObject({ Authorization: "glm-token" });
      return jsonResponse(
        monitorResponse([
          {
            type: "TOKENS_LIMIT",
            unit: "3",
            number: "5",
            percentage: "0",
            nextResetTime: String(SESSION_RESET),
          },
        ]),
      );
    }) as unknown as typeof fetch;

    await expect(
      createProvider({ env: { GLM_API_KEY: "glm-token" }, fetch: fetchApi }).fetchUsage(),
    ).resolves.toMatchObject({
      status: "available",
      planLabel: "max",
      windows: [{ id: "session", usedPct: 0, remainingPct: 100, tone: "ok" }],
    });
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["https://api.z.ai/api/anthropic", "https://api.z.ai"],
    ["https://open.bigmodel.cn/api/anthropic", "https://open.bigmodel.cn"],
  ])("reads the credential from a custom provider configured for %s", async (baseUrl, origin) => {
    const fetchApi = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe(`${origin}/api/monitor/usage/quota/limit`);
      expect(init?.headers).toMatchObject({ Authorization: "custom-token" });
      return jsonResponse(monitorResponse([], "Coding Plan"));
    }) as unknown as typeof fetch;

    const result = await createProvider({
      fetch: fetchApi,
      providerConfigs: {
        "my-glm": {
          env: {
            ANTHROPIC_AUTH_TOKEN: "custom-token",
            ANTHROPIC_BASE_URL: baseUrl,
          },
        },
      },
    }).fetchUsage();

    expect(result).toMatchObject({ status: "available", planLabel: "Coding Plan" });
  });

  it("ignores unrelated custom-provider credentials", async () => {
    const fetchApi = vi.fn();
    const result = await createProvider({
      fetch: fetchApi as unknown as typeof fetch,
      providerConfigs: {
        proxy: {
          env: {
            ANTHROPIC_AUTH_TOKEN: "secret",
            ANTHROPIC_BASE_URL: "https://proxy.example.com/v1",
          },
        },
      },
    }).fetchUsage();

    expect(result.status).toBe("unavailable");
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("returns unavailable when the monitor endpoint rejects the credential", async () => {
    const fetchApi = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401));

    await expect(
      createProvider({ env: { GLM_API_KEY: "bad-token" }, fetch: fetchApi }).fetchUsage(),
    ).resolves.toMatchObject({ status: "unavailable", windows: [] });
  });

  it("returns unavailable when the monitor API rejects the credential in a 200 response", async () => {
    const fetchApi = vi.fn(async () =>
      jsonResponse({ code: 401, success: false, message: "unauthorized" }),
    );

    await expect(
      createProvider({ env: { GLM_API_KEY: "bad-token" }, fetch: fetchApi }).fetchUsage(),
    ).resolves.toMatchObject({ status: "unavailable", windows: [] });
  });

  it("preserves null percentages and reset timestamps", async () => {
    const fetchApi = vi.fn(async () =>
      jsonResponse(
        monitorResponse([
          {
            type: "TOKENS_LIMIT",
            unit: 3,
            number: 5,
            percentage: null,
            nextResetTime: null,
          },
        ]),
      ),
    ) as unknown as typeof fetch;

    await expect(
      createProvider({ env: { GLM_API_KEY: "glm-token" }, fetch: fetchApi }).fetchUsage(),
    ).resolves.toMatchObject({
      status: "available",
      windows: [{ id: "session", usedPct: null, remainingPct: null, resetsAt: null }],
    });
  });

  it("keeps quota available when optional subscription metadata fails", async () => {
    const fetchApi = vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString().endsWith("/api/monitor/usage/quota/limit")) {
        return jsonResponse(
          monitorResponse(
            [
              {
                type: "TOKENS_LIMIT",
                unit: 3,
                number: 5,
                percentage: 100,
                nextResetTime: SESSION_RESET,
              },
            ],
            "pro",
          ),
        );
      }
      throw new TypeError("subscription endpoint unavailable");
    }) as unknown as typeof fetch;

    await expect(
      createProvider({ env: { ZAI_API_KEY: "zai-token" }, fetch: fetchApi }).fetchUsage(),
    ).resolves.toMatchObject({
      status: "available",
      planLabel: "pro",
      windows: [{ usedPct: 100, remainingPct: 0, tone: "danger" }],
    });
  });

  it("selects the enabled Z.ai profile with the lowest configured order, not first-match", async () => {
    let usedToken: string | null = null;
    const fetchApi = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString().endsWith("/api/monitor/usage/quota/limit")) {
        usedToken = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
        return jsonResponse(
          monitorResponse(
            [
              {
                type: "TOKENS_LIMIT",
                unit: 3,
                number: 5,
                percentage: 7,
                nextResetTime: SESSION_RESET,
              },
            ],
            "max",
          ),
        );
      }
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;

    // "work" is listed first but has the higher order; "personal" must win on order.
    await createProvider({
      fetch: fetchApi,
      providerConfigs: {
        work: {
          enabled: true,
          order: 2,
          env: {
            ANTHROPIC_AUTH_TOKEN: "work-token",
            ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
          },
        },
        personal: {
          enabled: true,
          order: 1,
          env: {
            ANTHROPIC_AUTH_TOKEN: "personal-token",
            ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
          },
        },
      },
    }).fetchUsage();

    expect(usedToken).toBe("personal-token");
  });

  it("skips a disabled Z.ai profile even when it has the lowest order", async () => {
    let usedToken: string | null = null;
    const fetchApi = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString().endsWith("/api/monitor/usage/quota/limit")) {
        usedToken = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
        return jsonResponse(
          monitorResponse(
            [
              {
                type: "TOKENS_LIMIT",
                unit: 3,
                number: 5,
                percentage: 7,
                nextResetTime: SESSION_RESET,
              },
            ],
            "max",
          ),
        );
      }
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;

    await createProvider({
      fetch: fetchApi,
      providerConfigs: {
        disabled: {
          enabled: false,
          order: 0,
          env: {
            ANTHROPIC_AUTH_TOKEN: "disabled-token",
            ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
          },
        },
        enabled: {
          enabled: true,
          order: 5,
          env: {
            ANTHROPIC_AUTH_TOKEN: "enabled-token",
            ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
          },
        },
      },
    }).fetchUsage();

    expect(usedToken).toBe("enabled-token");
  });

  it("falls back to the monitor plan label when subscription metadata lacks a product name", async () => {
    const fetchApi = vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString().endsWith("/api/monitor/usage/quota/limit")) {
        return jsonResponse(
          monitorResponse(
            [
              {
                type: "TOKENS_LIMIT",
                unit: 3,
                number: 5,
                percentage: 7,
                nextResetTime: SESSION_RESET,
              },
            ],
            "max",
          ),
        );
      }
      return jsonResponse({ data: [{ status: "VALID" }] });
    }) as unknown as typeof fetch;

    await expect(
      createProvider({ env: { ZAI_API_KEY: "zai-token" }, fetch: fetchApi }).fetchUsage(),
    ).resolves.toMatchObject({ status: "available", planLabel: "max" });
  });

  it("does not block when the optional subscription endpoint hangs beyond its timeout", async () => {
    const fetchApi = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/monitor/usage/quota/limit")) {
        return jsonResponse(
          monitorResponse(
            [
              {
                type: "TOKENS_LIMIT",
                unit: 3,
                number: 5,
                percentage: 7,
                nextResetTime: SESSION_RESET,
              },
            ],
            "max",
          ),
        );
      }
      // Never resolves on its own; only the subscription AbortSignal timeout can end it.
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("subscription hung")));
      });
    }) as unknown as typeof fetch;

    const result = await createProvider({
      env: { ZAI_API_KEY: "zai-token" },
      fetch: fetchApi,
    }).fetchUsage();

    // Monitor-derived quota is returned even though the subscription never completed.
    expect(result).toMatchObject({ status: "available", planLabel: "max" });
  }, 15_000);
});
