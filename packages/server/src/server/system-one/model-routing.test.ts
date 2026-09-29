import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { SystemOneCredentialStore } from "./credential-store.js";
import { createSystemOneTurnRouter } from "./model-routing.js";

const homes: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(path.join(os.tmpdir(), "paseo-routing-"));
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
              thinking: ["low", "medium", "high"],
            },
          },
        },
      },
    }),
  );
  new SystemOneCredentialStore(home, { env: {}, sharedEnvFile: "/missing" }).set("key");
  const router = createSystemOneTurnRouter({
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
  });
  return { router };
}

function answer(choice: string, confidence: number, count = 3) {
  const probabilities = Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `tier${index + 1}`,
      `tier${index + 1}` === choice ? 1 : 0,
    ]),
  );
  return { choice, confidence, probabilities };
}

function stubJev(answers: Record<string, unknown>) {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ model: "jev-latest", answers })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("createSystemOneTurnRouter", () => {
  it("maps Jev's tiers onto the provider's ladder", async () => {
    const { router } = setup();
    stubJev({ model: answer("tier1", 0.9), thinking: answer("tier2", 0.9) });

    await expect(
      router({
        provider: "claude",
        cwd: "/repo",
        model: "claude-opus-5-5",
        thinkingOptionId: "high",
        prompt: "What does git status say?",
        isFirstTurn: true,
      }),
    ).resolves.toEqual({ model: "claude-haiku-4-5", thinkingOptionId: "medium" });
  });

  it("keeps the current setting when Jev is unsure", async () => {
    const { router } = setup();
    stubJev({ model: answer("tier1", 0.2), thinking: answer("tier1", 0.2) });

    await expect(
      router({
        provider: "claude",
        cwd: "/repo",
        model: "claude-opus-5-5",
        thinkingOptionId: undefined,
        prompt: "Refactor the auth layer",
        isFirstTurn: true,
      }),
    ).resolves.toBeNull();
  });

  it("asks nothing for providers without a ladder", async () => {
    const { router } = setup();
    const fetchMock = stubJev({});

    await expect(
      router({
        provider: "codex",
        cwd: "/repo",
        model: "gpt-6-sol",
        thinkingOptionId: undefined,
        prompt: "Fix the test",
        isFirstTurn: true,
      }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never steps down after the first turn, but still escalates", async () => {
    const { router } = setup();
    stubJev({ model: answer("tier1", 0.9), thinking: answer("tier1", 0.9) });
    await expect(
      router({
        provider: "claude",
        cwd: "/repo",
        model: "claude-opus-5-5",
        thinkingOptionId: "high",
        prompt: "go on",
        isFirstTurn: false,
      }),
    ).resolves.toBeNull();

    stubJev({ model: answer("tier3", 0.9), thinking: answer("tier3", 0.9) });
    await expect(
      router({
        provider: "claude",
        cwd: "/repo",
        model: "claude-sonnet-5",
        thinkingOptionId: "low",
        prompt: "Now redesign the storage layer for multi-region writes",
        isFirstTurn: false,
      }),
    ).resolves.toEqual({ model: "claude-opus-5-5", thinkingOptionId: "high" });

    stubJev({ model: answer("tier3", 0.9), thinking: answer("tier3", 0.9) });
    await expect(
      router({
        provider: "claude",
        cwd: "/repo",
        model: "claude-opus-5",
        thinkingOptionId: undefined,
        prompt: "Continue",
        isFirstTurn: false,
      }),
    ).resolves.toBeNull();
  });
});
