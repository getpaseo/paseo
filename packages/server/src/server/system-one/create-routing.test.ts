import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { SystemOneCredentialStore } from "./credential-store.js";
import { createSystemOneCreateRouter } from "./create-routing.js";
import type { ProviderUsage } from "../messages.js";
import * as usageLog from "./usage-log.js";

const homes: string[] = [];
const usageWrites = vi.spyOn(usageLog, "recordSystemOneUsage");

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    usageWrites.mock.results
      .filter((result) => result.type === "return")
      .map((result) => result.value),
  );
  usageWrites.mockClear();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup(usage: ProviderUsage[] = []) {
  const home = mkdtempSync(path.join(os.tmpdir(), "paseo-create-routing-"));
  homes.push(home);
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      version: 1,
      daemon: {
        systemOne: {
          enabled: true,
          routing: {
            claude: {
              models: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5-5"],
              thinking: ["low", "medium", "high", "xhigh"],
            },
            codex: {
              models: ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"],
              thinking: ["low", "medium", "high", "xhigh"],
            },
          },
        },
      },
    }),
  );
  new SystemOneCredentialStore(home, { env: {}, sharedEnvFile: "/missing" }).set("key");
  const router = createSystemOneCreateRouter({
    paseoHome: home,
    daemonConfigStore: {
      get: () => ({
        systemOne: {
          enabled: true,
          model: "jev-latest",
          endpoint: "https://api.typesafe.ai/v1/systemone",
          minimumConfidence: 0.5,
        },
      }),
    } as unknown as Pick<DaemonConfigStore, "get">,
    getUsage: async () => ({
      fetchedAt: new Date(0).toISOString(),
      providers: usage,
    }),
  });
  return { router };
}

function jevTier(choice: string, confidence = 0.9) {
  const probabilities = Object.fromEntries(
    ["tier1", "tier2", "tier3"].map((tier) => [tier, tier === choice ? 1 : 0]),
  );
  return { choice, confidence, probabilities };
}

function stubJev(choice: string, confidence = 0.9) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "jev-latest",
            answers: { complexity: jevTier(choice, confidence) },
          }),
        ),
    ),
  );
}

function usageEntry(
  providerId: string,
  usedPct: number | null,
  status = "available",
): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    status: status as ProviderUsage["status"],
    planLabel: null,
    windows:
      usedPct === null
        ? []
        : [{ id: "session", label: "Session", usedPct, remainingPct: 100 - usedPct }],
    balances: [],
    details: [],
    error: null,
  };
}

describe("createSystemOneCreateRouter", () => {
  it("ignores human session creates", async () => {
    const { router } = setup();
    stubJev("tier1");
    await expect(
      router({
        requestedProvider: "claude",
        requestedModel: "claude-opus-5-5",
        requestedThinking: "xhigh",
        prompt: "Fix a typo",
        cwd: "/repo",
        isAgentScoped: false,
      }),
    ).resolves.toBeNull();
  });

  it("caps trivial subagents to the cheapest rung", async () => {
    const { router } = setup([usageEntry("claude", 10), usageEntry("codex", 10)]);
    stubJev("tier1");
    await expect(
      router({
        requestedProvider: "claude",
        requestedModel: "claude-opus-5-5",
        requestedThinking: "xhigh",
        prompt: "What does git status say?",
        cwd: "/repo",
        isAgentScoped: true,
      }),
    ).resolves.toEqual({
      provider: "claude",
      model: "claude-haiku-4-5",
      thinkingOptionId: "low",
    });
  });

  it("switches providers when the requested one is exhausted", async () => {
    const { router } = setup([usageEntry("claude", 100), usageEntry("codex", 5)]);
    stubJev("tier1");
    await expect(
      router({
        requestedProvider: "claude",
        requestedModel: "claude-opus-5-5",
        requestedThinking: "xhigh",
        prompt: "Look up a status",
        cwd: "/repo",
        isAgentScoped: true,
      }),
    ).resolves.toEqual({
      provider: "codex",
      model: "gpt-6-luna",
      thinkingOptionId: "low",
    });
  });

  it("falls back cheap when Jev fails", async () => {
    const { router } = setup([usageEntry("claude", 10)]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("TypeSafe down");
      }),
    );
    await expect(
      router({
        requestedProvider: "claude",
        requestedModel: "claude-opus-5-5",
        requestedThinking: "xhigh",
        prompt: "Small mechanical edit",
        cwd: "/repo",
        isAgentScoped: true,
      }),
    ).resolves.toEqual({
      provider: "claude",
      model: "claude-haiku-4-5",
      thinkingOptionId: "low",
    });
  });
});
