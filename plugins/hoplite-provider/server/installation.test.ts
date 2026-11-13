import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderInstallationLaunch } from "@getpaseo/plugin/server/provider";
import { createHopliteInstallation } from "./installation.js";

const temporary: string[] = [];
const signal = new AbortController().signal;

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A `hoplite` that records its arguments and prints `banner` for `--version`. */
async function fakeHoplite(banner: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paseo-hoplite-"));
  temporary.push(dir);
  const script = path.join(dir, "hoplite.mjs");
  const record = path.join(dir, "args.json");
  await writeFile(
    script,
    [
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));`,
      `console.log(${JSON.stringify(banner)});`,
    ].join("\n"),
  );
  // Sessions launch `hoplite acp` plus any configured arguments.
  const launch: ProviderInstallationLaunch = {
    command: process.execPath,
    args: [script, "acp", "--verbose"],
    env: {},
    resolved: true,
  };
  return { launch, args: async () => JSON.parse(await readFile(record, "utf8")) as string[] };
}

function latest(version: string) {
  return async () => version;
}

describe("Hoplite installation", () => {
  it("reads the version from the launch without `acp`", async () => {
    const hoplite = await fakeHoplite("3.4.0");
    const installation = createHopliteInstallation(latest("3.5.1"));
    await expect(installation.inspect!({ launch: hoplite.launch, signal })).resolves.toEqual({
      status: "installed",
      version: "3.4.0",
    });
    expect(await hoplite.args()).toEqual(["--version"]);
  });

  it("compares the installed version with the release the installer reads", async () => {
    const hoplite = await fakeHoplite("3.4.0");
    const check = (release: string) =>
      createHopliteInstallation(latest(release)).checkForUpdates!({
        launch: hoplite.launch,
        signal,
      });
    await expect(check("3.5.1")).resolves.toEqual({ status: "available", versions: ["3.5.1"] });
    await expect(check("3.4.0")).resolves.toEqual({ status: "current" });
    await expect(check("3.3.9")).resolves.toEqual({ status: "current" });
    await expect(check("<html>")).resolves.toEqual({
      status: "unknown",
      message: "Unrecognized release <html>",
    });
  });

  it("does not check when the user turned Hoplite's update check off", async () => {
    const hoplite = await fakeHoplite("3.4.0");
    const launch = { ...hoplite.launch, env: { HOPLITE_NO_UPDATE_CHECK: "1" } };
    await expect(
      createHopliteInstallation(latest("3.5.1")).checkForUpdates!({ launch, signal }),
    ).resolves.toEqual({
      status: "unknown",
      message: "HOPLITE_NO_UPDATE_CHECK turns update checks off",
    });
  });

  it("links the upgrade docs and runs no updater, since the CLI does not update itself", () => {
    const installation = createHopliteInstallation();
    expect(installation.updateUrl).toBe("https://hoplite.sh/docs/cli#upgrade");
    expect(installation.update).toBeUndefined();
  });

  it("is not installed when the executable does not resolve", async () => {
    const launch = { command: "hoplite", args: ["acp"], env: {}, resolved: false };
    const installation = createHopliteInstallation(latest("3.5.1"));
    await expect(installation.inspect!({ launch, signal })).resolves.toEqual({
      status: "not_installed",
    });
  });
});
