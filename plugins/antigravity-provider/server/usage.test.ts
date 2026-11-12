import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { Usage } from "./usage.js";

const fakeAgy = fileURLToPath(new URL("../test/agy.mjs", import.meta.url));
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createDataDir(withLoginMarker = true): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agy-usage-test-"));
  temporary.push(dir);
  if (withLoginMarker) {
    await writeFile(path.join(dir, "jetski_state.pbtxt"), 'user_tier: "ultra"\n', "utf8");
  }
  return dir;
}

function fakeLaunch(dataDir: string, extraEnv: Record<string, string> = {}): ProviderLaunch {
  return {
    command: process.execPath,
    args: [fakeAgy],
    env: {
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
      ...extraEnv,
    },
  };
}

describe("antigravity usage source", () => {
  it("discovers logged-in global and antigravity session accounts with hashed keys", async () => {
    const dataDir = await createDataDir(true);
    const usage = new Usage();
    usage.rememberLaunch(fakeLaunch(dataDir));
    const reg = usage.registration();

    expect(reg.id).toBe("antigravity");
    expect(reg.label).toBe("Antigravity");

    const globalLocators = await reg.discover({ kind: "global" });
    expect(globalLocators).toHaveLength(1);
    expect(globalLocators[0]?.harness).toBe("Antigravity");
    expect(globalLocators[0]?.key).not.toContain(dataDir);
    expect(globalLocators[0]?.key).toMatch(/^[A-Za-z0-9._-]{1,128}$/);

    const otherSessionLocators = await reg.discover({
      kind: "session",
      provider: "claude",
      env: { ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir },
    });
    expect(otherSessionLocators).toEqual([]);

    const agySessionLocators = await reg.discover({
      kind: "session",
      provider: "antigravity",
      env: { ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir },
    });
    expect(agySessionLocators).toEqual(globalLocators);
  });

  it("returns empty discovery when no Antigravity login markers exist", async () => {
    const emptyDataDir = await createDataDir(false);
    const usage = new Usage();
    usage.rememberLaunch(fakeLaunch(emptyDataDir));
    const reg = usage.registration();

    const locators = await reg.discover({ kind: "global" });
    expect(locators).toEqual([]);
  });

  it("fetches JSON quota buckets sorted 5h-before-weekly, tier planLabel, and AI Credits", async () => {
    const dataDir = await createDataDir(true);
    const usage = new Usage();
    const { locatorId } = usage.rememberLaunch(
      fakeLaunch(dataDir, { AGY_TEST_USAGE: "json", AGY_TEST_CREDITS: "json" }),
    );
    usage.rememberTier(locatorId, "Google AI Ultra");

    const reg = usage.registration();
    const [locator] = await reg.discover({ kind: "global" });
    expect(locator).toBeDefined();

    const report = await reg.fetch(locator!.input);
    expect(report).toMatchObject({
      status: "available",
      planLabel: "Google AI Ultra",
      windows: [
        {
          id: "gemini-5h",
          label: "Gemini Models · 5-hour",
          shortLabel: "Gemini 5h",
          summary: true,
          usedPct: 32,
          remainingPct: 68,
          resetsAt: "2026-11-11T07:04:06.000Z",
        },
        {
          id: "gemini-weekly",
          label: "Gemini Models · Weekly",
          shortLabel: "Gemini wk",
          usedPct: 27,
          remainingPct: 73,
          resetsAt: "2026-11-14T05:30:13.000Z",
        },
        {
          id: "3p-5h",
          label: "Claude and GPT models · 5-hour",
          shortLabel: "Claude/GPT 5h",
          summary: true,
          usedPct: 0,
          remainingPct: 100,
          resetsAt: "2026-11-11T11:41:37.000Z",
        },
        {
          id: "3p-weekly",
          label: "Claude and GPT models · Weekly",
          shortLabel: "Claude/GPT wk",
          usedPct: 14,
          remainingPct: 86,
          resetsAt: "2026-11-15T08:19:51.000Z",
        },
      ],
      balances: [
        {
          id: "credits",
          label: "AI Credits",
          remaining: 420,
          unit: "credits",
        },
      ],
    });
  });

  it("omits zero credit balance when quota windows exist and falls back to TSV parsing", async () => {
    const dataDir = await createDataDir(true);
    await mkdir(path.join(dataDir, "cache"), { recursive: true });
    const usage = new Usage();
    usage.rememberLaunch(fakeLaunch(dataDir, { AGY_TEST_USAGE: "tsv", AGY_TEST_CREDITS: "zero" }));

    const reg = usage.registration();
    const [locator] = await reg.discover({ kind: "global" });
    const report = await reg.fetch(locator!.input);

    expect(report).toMatchObject({
      status: "available",
      windows: [
        { shortLabel: "Gemini 5h" },
        { shortLabel: "Gemini wk" },
        { shortLabel: "Claude/GPT 5h" },
        { shortLabel: "Claude/GPT wk" },
      ],
    });
    expect(report).not.toHaveProperty("balances");
  });

  it("maps 401, 403, and empty quota responses to unavailable reports", async () => {
    const dataDir401 = await createDataDir(true);
    const usage401 = new Usage();
    usage401.rememberLaunch(fakeLaunch(dataDir401, { AGY_TEST_USAGE: "auth" }));
    const reg401 = usage401.registration();
    const [loc401] = await reg401.discover({ kind: "global" });
    const report401 = await reg401.fetch(loc401!.input);
    expect(report401).toMatchObject({
      status: "unavailable",
      problem: { kind: "rejected", status: 401, refreshedBy: "agy" },
    });

    const dataDir403 = await createDataDir(true);
    const usage403 = new Usage();
    usage403.rememberLaunch(fakeLaunch(dataDir403, { AGY_TEST_USAGE: "forbidden" }));
    const reg403 = usage403.registration();
    const [loc403] = await reg403.discover({ kind: "global" });
    const report403 = await reg403.fetch(loc403!.input);
    expect(report403).toMatchObject({
      status: "unavailable",
      problem: { kind: "rejected", status: 403, refreshedBy: "agy" },
    });

    const dataDirEmpty = await createDataDir(true);
    const usageEmpty = new Usage();
    usageEmpty.rememberLaunch(
      fakeLaunch(dataDirEmpty, { AGY_TEST_USAGE: "empty", AGY_TEST_CREDITS: "zero" }),
    );
    const regEmpty = usageEmpty.registration();
    const [locEmpty] = await regEmpty.discover({ kind: "global" });
    const reportEmpty = await regEmpty.fetch(locEmpty!.input);
    expect(reportEmpty).toMatchObject({
      status: "unavailable",
      problem: { kind: "no_quota" },
    });
  });
});
