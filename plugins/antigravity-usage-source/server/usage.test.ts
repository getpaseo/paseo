import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import { fetchUsage } from "./usage.js";
import type { AntigravityUsageInput } from "../shared/input.js";

describe("antigravity usage fetcher", () => {
  let tempHome: string;
  let authFile: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "agy-fetch-home-"));
    authFile = join(tempHome, "antigravity-oauth-token");
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  const makeInput = (path: string): AntigravityUsageInput => ({
    route: { store: "antigravity", path },
  });

  it("returns unavailable expired when token expiration is in the past", async () => {
    await writeFile(
      authFile,
      JSON.stringify({
        token: {
          access_token: "expired-token",
          expiry: "2026-10-01T10:00:00Z",
        },
      }),
    );

    const report = await fetchUsage(makeInput(authFile), fetch, {
      now: () => new Date("2026-10-13T12:00:00Z").getTime(),
    });

    expect(report).toEqual({
      status: "unavailable",
      problem: {
        kind: "expired",
        expiresAt: "2026-10-01T10:00:00.000Z",
        refreshedBy: "agy",
      },
    });
  });

  it("returns unavailable rejected on HTTP 401 and 403 without modifying credentials", async () => {
    await writeFile(
      authFile,
      JSON.stringify({
        token: { access_token: "valid-looking-token" },
      }),
    );

    const mock401 = async () =>
      new Response(JSON.stringify({ error: { code: 401 } }), { status: 401 });
    const report401 = await fetchUsage(makeInput(authFile), mock401 as unknown as typeof fetch);

    expect(report401).toEqual({
      status: "unavailable",
      problem: {
        kind: "rejected",
        status: 401,
        refreshedBy: "agy",
      },
    });

    const mock403 = async () =>
      new Response(JSON.stringify({ error: { code: 403 } }), { status: 403 });
    const report403 = await fetchUsage(makeInput(authFile), mock403 as unknown as typeof fetch);

    expect(report403).toEqual({
      status: "unavailable",
      problem: {
        kind: "rejected",
        status: 403,
        refreshedBy: "agy",
      },
    });
  });

  it("propagates TimeoutError from loadCodeAssist", async () => {
    await writeFile(
      authFile,
      JSON.stringify({
        token: { access_token: "token" },
      }),
    );

    const mockTimeout = async () => {
      const err = new Error("The operation timed out");
      err.name = "TimeoutError";
      throw err;
    };

    await expect(
      fetchUsage(makeInput(authFile), mockTimeout as unknown as typeof fetch),
    ).rejects.toThrow("The operation timed out");
  });

  it("throws when loadCodeAssist returns HTTP error", async () => {
    await writeFile(
      authFile,
      JSON.stringify({
        token: { access_token: "token" },
      }),
    );

    const mock500 = async (url: string | URL | Request) => {
      if (String(url).includes("loadCodeAssist")) {
        return new Response("Server error", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    };

    await expect(
      fetchUsage(makeInput(authFile), mock500 as unknown as typeof fetch),
    ).rejects.toThrow("Antigravity account API returned 500");
  });

  it("throws when endpoint returns HTML error page", async () => {
    await writeFile(
      authFile,
      JSON.stringify({
        token: { access_token: "token" },
      }),
    );

    const mockHtml = async (url: string | URL | Request) => {
      if (String(url).includes("loadCodeAssist")) {
        return new Response("{}", { status: 200 });
      }
      return new Response("<html><body>Service Unavailable</body></html>", { status: 200 });
    };

    await expect(
      fetchUsage(makeInput(authFile), mockHtml as unknown as typeof fetch),
    ).rejects.toThrow("Antigravity usage API returned HTML");
  });

  it("groups models into Gemini and Claude & OSS quota buckets, filters telemetry, and respects currentTier", async () => {
    await writeFile(
      authFile,
      JSON.stringify({
        token: { access_token: "valid-token" },
      }),
    );

    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("loadCodeAssist")) {
        return new Response(
          JSON.stringify({
            currentTier: { id: "standard-tier" },
            paidTier: { id: "upgrade-pro-tier" },
            cloudaicompanionProject: "custom-project",
          }),
          { status: 200 },
        );
      }
      if (urlStr.includes("fetchAvailableModels")) {
        return new Response(
          JSON.stringify({
            models: {
              "gemini-3.1-pro-high": {
                displayName: "Gemini 3.1 Pro (High)",
                model: "gemini-3.1-pro-high",
                quotaInfo: {
                  remainingFraction: 0.8,
                  resetTime: "2026-10-13T18:00:00Z",
                },
              },
              "gemini-2.5-pro": {
                displayName: "Gemini 2.5 Pro",
                model: "gemini-2.5-pro",
                quotaInfo: {
                  remainingFraction: 0.8,
                  resetTime: "2026-10-13T18:00:00Z",
                },
              },
              "claude-opus-5-5-high": {
                displayName: "Claude Opus 5.5 (High)",
                model: "claude-opus-5-5-high",
                quotaInfo: {
                  remainingFraction: 1,
                  resetTime: "2026-10-13T19:00:00Z",
                },
              },
              "gpt-oss-120b-medium": {
                displayName: "GPT-OSS 120B (Medium)",
                model: "gpt-oss-120b-medium",
                quotaInfo: {
                  remainingFraction: 1,
                  resetTime: "2026-10-13T19:00:00Z",
                },
              },
              tab_flash_lite_preview: {
                displayName: "Internal Tab",
                quotaInfo: { remainingFraction: 0.5 },
              },
              chat_20706: {
                displayName: "Internal Chat",
                quotaInfo: { remainingFraction: 0.5 },
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const report = await fetchUsage(makeInput(authFile), mockFetch as unknown as typeof fetch);

    expect(report.status).toBe("available");
    assert(report.status === "available");
    expect(report.planLabel).toBe("standard-tier");
    expect(report.windows).toHaveLength(2);

    const geminiWindow = report.windows.find((w) => w.id === "gemini");
    expect(geminiWindow).toMatchObject({
      id: "gemini",
      label: "Gemini (all models)",
      shortLabel: "Gemini",
      usedPct: 20,
      remainingPct: 80,
      summary: true,
      resetsAt: "2026-10-13T18:00:00Z",
      tone: "ok",
    });

    const claudeOssWindow = report.windows.find((w) => w.id === "claude-gpt-oss");
    expect(claudeOssWindow).toMatchObject({
      id: "claude-gpt-oss",
      label: "Claude & GPT-OSS (all models)",
      shortLabel: "Claude/OSS",
      usedPct: 0,
      remainingPct: 100,
      summary: true,
      resetsAt: "2026-10-13T19:00:00Z",
      tone: "ok",
    });
  });

  it("selects the most constrained quota in a bucket when models diverge", async () => {
    await writeFile(
      authFile,
      JSON.stringify({
        token: { access_token: "valid-token" },
      }),
    );

    const mockFetch = async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("loadCodeAssist")) {
        return new Response("{}", { status: 200 });
      }
      if (urlStr.includes("fetchAvailableModels")) {
        return new Response(
          JSON.stringify({
            models: {
              "gemini-3.1-pro-high": {
                displayName: "Gemini 3.1 Pro (High)",
                quotaInfo: {
                  remainingFraction: 0.4,
                  resetTime: "2026-10-13T16:00:00Z",
                },
              },
              "gemini-3-flash": {
                displayName: "Gemini 3 Flash",
                quotaInfo: {
                  remainingFraction: 0.7,
                  resetTime: "2026-10-13T17:00:00Z",
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const report = await fetchUsage(makeInput(authFile), mockFetch as unknown as typeof fetch);

    expect(report.status).toBe("available");
    assert(report.status === "available");
    expect(report.windows).toHaveLength(1);
    expect(report.windows[0]).toMatchObject({
      id: "gemini",
      label: "Gemini (all models)",
      usedPct: 60,
      remainingPct: 40,
      resetsAt: "2026-10-13T16:00:00Z",
    });
  });
});
