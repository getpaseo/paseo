import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { render } from "../output/render.js";
import type { CommandOptions } from "../output/index.js";
import { runHomeMigrateCommand } from "./home.js";

describe("home migrate", () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "cli-home-migrate-"));
    process.env.HOME = homeDir;
    await mkdir(path.join(homeDir, ".paseo"));
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  function run(dryRun: boolean) {
    const options = { dryRun } as unknown as CommandOptions;
    return runHomeMigrateCommand(options, {} as Command);
  }

  test("dry run describes the move without performing it", async () => {
    const output = render(await run(true));

    expect(output).toBe(
      `Dry run: would move ${homeDir}/.paseo to ${homeDir}/.pandaos and link ${homeDir}/.paseo -> ${homeDir}/.pandaos.`,
    );
    expect((await lstat(path.join(homeDir, ".paseo"))).isDirectory()).toBe(true);
  });

  test("migrates, then reports already migrated", async () => {
    expect(render(await run(false))).toContain(`Moved ${homeDir}/.paseo to ${homeDir}/.pandaos`);
    expect((await lstat(path.join(homeDir, ".paseo"))).isSymbolicLink()).toBe(true);
    expect(render(await run(false))).toBe(
      `Already migrated: ${homeDir}/.paseo links to ${homeDir}/.pandaos.`,
    );
  });
});
