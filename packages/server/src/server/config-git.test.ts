import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createHome(config: object = {}): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "paseo-config-git-"));
  roots.push(home);
  await writeFile(path.join(home, "config.json"), JSON.stringify(config));
  return home;
}

describe("daemon Git process config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("defaults the global process limits", async () => {
    const home = await createHome();

    expect(loadConfig(home, { env: {} }).git).toEqual({
      maxProcessesPerSecond: 64,
      maxProcessConcurrency: 8,
    });
  });

  test("loads both limits from daemon.git", async () => {
    const home = await createHome({
      daemon: {
        git: {
          maxProcessesPerSecond: 5,
          maxProcessConcurrency: 4,
        },
      },
    });

    expect(loadConfig(home, { env: {} }).git).toEqual({
      maxProcessesPerSecond: 5,
      maxProcessConcurrency: 4,
    });
  });

  test("new environment variables override config.json", async () => {
    const home = await createHome({
      daemon: {
        git: {
          maxProcessesPerSecond: 5,
          maxProcessConcurrency: 4,
        },
      },
    });

    expect(
      loadConfig(home, {
        env: {
          PASEO_GIT_MAX_PROCESSES_PER_SECOND: "12",
          PASEO_GIT_MAX_PROCESS_CONCURRENCY: "6",
        },
      }).git,
    ).toEqual({
      maxProcessesPerSecond: 12,
      maxProcessConcurrency: 6,
    });
  });

  test("accepts legacy PASEO_GIT_CONCURRENCY below the renamed variable", async () => {
    const home = await createHome();

    expect(
      loadConfig(home, {
        env: {
          PASEO_GIT_CONCURRENCY: "3",
        },
      }).git?.maxProcessConcurrency,
    ).toBe(3);
    expect(
      loadConfig(home, {
        env: {
          PASEO_GIT_CONCURRENCY: "3",
          PASEO_GIT_MAX_PROCESS_CONCURRENCY: "7",
        },
      }).git?.maxProcessConcurrency,
    ).toBe(7);
  });
});

describe("daemon background Git fetch config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("stays off when neither the key nor the variable is set", async () => {
    const home = await createHome();

    expect(loadConfig(home, { env: {} }).backgroundGitFetchIntervalMinutes).toBe(0);
  });

  test("reads the persisted key", async () => {
    const home = await createHome({ daemon: { git: { backgroundFetchIntervalMinutes: 3 } } });

    expect(loadConfig(home, { env: {} }).backgroundGitFetchIntervalMinutes).toBe(3);
  });

  test("accepts an explicit persisted zero", async () => {
    const home = await createHome({ daemon: { git: { backgroundFetchIntervalMinutes: 0 } } });

    expect(loadConfig(home, { env: {} }).backgroundGitFetchIntervalMinutes).toBe(0);
  });

  test("prefers a valid environment variable over the persisted key", async () => {
    const home = await createHome({ daemon: { git: { backgroundFetchIntervalMinutes: 3 } } });

    expect(
      loadConfig(home, { env: { PASEO_GIT_BACKGROUND_FETCH_INTERVAL_MINUTES: "7" } })
        .backgroundGitFetchIntervalMinutes,
    ).toBe(7);
  });

  test("lets an environment variable of zero turn the persisted interval off", async () => {
    const home = await createHome({ daemon: { git: { backgroundFetchIntervalMinutes: 3 } } });

    expect(
      loadConfig(home, { env: { PASEO_GIT_BACKGROUND_FETCH_INTERVAL_MINUTES: "0" } })
        .backgroundGitFetchIntervalMinutes,
    ).toBe(0);
  });

  test.each([
    { name: "blank", value: "" },
    { name: "whitespace", value: "   " },
    { name: "malformed", value: "three" },
    { name: "negative", value: "-1" },
    { name: "fractional", value: "2.5" },
  ])("keeps the persisted interval when the variable is $name", async ({ value }) => {
    const home = await createHome({ daemon: { git: { backgroundFetchIntervalMinutes: 3 } } });

    const config = loadConfig(home, {
      env: { PASEO_GIT_BACKGROUND_FETCH_INTERVAL_MINUTES: value },
    });

    expect(config.backgroundGitFetchIntervalMinutes).toBe(3);
    expect(config.configReload?.overrideControlledPaths).not.toContain(
      "daemon.git.backgroundFetchIntervalMinutes",
    );
  });

  test("marks the key override-controlled when the variable is valid", async () => {
    const home = await createHome({ daemon: { git: { backgroundFetchIntervalMinutes: 3 } } });

    expect(
      loadConfig(home, { env: { PASEO_GIT_BACKGROUND_FETCH_INTERVAL_MINUTES: "7" } }).configReload
        ?.overrideControlledPaths,
    ).toContain("daemon.git.backgroundFetchIntervalMinutes");
  });

  test.each([
    { name: "the persisted key", env: {}, persisted: 40_000 },
    { name: "the variable", env: { PASEO_GIT_BACKGROUND_FETCH_INTERVAL_MINUTES: "40000" } },
  ])("caps an oversized interval from $name", async ({ env, persisted }) => {
    const home = await createHome({
      daemon: { git: { backgroundFetchIntervalMinutes: persisted ?? 3 } },
    });

    const minutes = loadConfig(home, { env }).backgroundGitFetchIntervalMinutes;

    expect(minutes).toBe(1_440);
    // The timer delay has to survive Node's 32-bit signed truncation.
    expect(minutes * 60_000).toBeLessThanOrEqual(2_147_483_647);
  });
});
