import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { SystemOneCredentialStore } from "./credential-store.js";
import { BROWSER_GOALS_OFF_MESSAGE, createConfiguredSystemOneDecisionSource } from "./tools.js";
import { recordSystemOneUsage, summarizeSystemOneUsage } from "./usage-log.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pandaos-jev-usage-"));
  directories.push(dir);
  return dir;
}

function configStore(browserGoals?: boolean): Pick<DaemonConfigStore, "get"> {
  return {
    get: () => ({
      systemOne: {
        enabled: true,
        model: "jev-latest",
        endpoint: "https://api.typesafe.ai/v1/systemone",
        minimumConfidence: 0.5,
        ...(browserGoals === undefined ? {} : { browserGoals }),
      },
    }),
  } as unknown as Pick<DaemonConfigStore, "get">;
}

const QUESTION = { q: { type: "choice" as const, criteria: { a: "A", b: "B" } } };

describe("System One usage log", () => {
  it("sums today and the last seven days per purpose and drops older calls", async () => {
    const paseoHome = await home();
    const now = new Date(2026, 8, 30, 12, 0, 0);
    const daysAgo = (days: number) => new Date(2026, 8, 30 - days, 9, 0, 0);
    await recordSystemOneUsage(paseoHome, "browser", { inputTokens: 300, outputTokens: 30 }, now);
    await recordSystemOneUsage(paseoHome, "browser", { inputTokens: 100, outputTokens: 10 }, now);
    await recordSystemOneUsage(
      paseoHome,
      "shadow",
      { inputTokens: 50, outputTokens: 5 },
      daysAgo(3),
    );
    await recordSystemOneUsage(
      paseoHome,
      "shadow",
      { inputTokens: 999, outputTokens: 9 },
      daysAgo(7),
    );

    const summary = await summarizeSystemOneUsage(paseoHome, now);

    expect(summary.today).toEqual({ browser: { calls: 2, inputTokens: 400, outputTokens: 40 } });
    expect(summary.last7Days).toEqual({
      browser: { calls: 2, inputTokens: 400, outputTokens: 40 },
      shadow: { calls: 1, inputTokens: 50, outputTokens: 5 },
    });
  });

  it("returns empty buckets before the first call", async () => {
    expect(await summarizeSystemOneUsage(await home())).toEqual({ today: {}, last7Days: {} });
  });
});

describe("configured decision source", () => {
  it("records the tokens TypeSafe reports under the caller's purpose", async () => {
    const paseoHome = await home();
    new SystemOneCredentialStore(paseoHome, { env: {} }).set("key");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: "jev-1.13.0",
              answers: { q: { choice: "a", confidence: 1, probabilities: { a: 1, b: 0 } } },
              usage: { input_tokens: 310, output_tokens: 31 },
            }),
          ),
      ),
    );
    const source = createConfiguredSystemOneDecisionSource(
      paseoHome,
      configStore(),
      undefined,
      "browser",
    );

    const decision = await source.decide({ state: {}, questions: QUESTION });

    expect(decision.usage).toEqual({ inputTokens: 310, outputTokens: 31 });
    await vi.waitFor(async () => {
      const raw = await readFile(path.join(paseoHome, "system-one", "usage.jsonl"), "utf8");
      expect(JSON.parse(raw.trim())).toMatchObject({
        purpose: "browser",
        inputTokens: 310,
        outputTokens: 31,
      });
    });
  });

  it("refuses browser decisions when browser goals are off but keeps other purposes", async () => {
    const paseoHome = await home();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const browser = createConfiguredSystemOneDecisionSource(
      paseoHome,
      configStore(false),
      undefined,
      "browser",
    );

    await expect(browser.decide({ state: {}, questions: QUESTION })).rejects.toThrow(
      BROWSER_GOALS_OFF_MESSAGE,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    const routing = createConfiguredSystemOneDecisionSource(
      paseoHome,
      configStore(false),
      undefined,
      "routing",
    );
    // Routing still reaches the key check, so the switch did not block it.
    await expect(routing.decide({ state: {}, questions: QUESTION })).rejects.toThrow(
      /API key|TypeSafe/,
    );
  });
});
