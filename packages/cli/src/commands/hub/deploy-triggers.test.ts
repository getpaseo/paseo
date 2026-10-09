import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverHubTriggers } from "./deploy-triggers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Hub trigger deployment discovery", () => {
  it("discovers self-contained triggers in deterministic order", async () => {
    const cwd = await temporaryDirectory();
    await mkdir(path.join(cwd, ".paseo", "triggers"), { recursive: true });
    await writeFile(path.join(cwd, ".paseo", "triggers", "z.yml"), "name: z\n");
    await writeFile(path.join(cwd, ".paseo", "triggers", "a.yml"), "name: a\n");

    await expect(discoverHubTriggers(cwd)).resolves.toEqual([
      { path: ".paseo/triggers/a.yml", yaml: "name: a\n" },
      { path: ".paseo/triggers/z.yml", yaml: "name: z\n" },
    ]);
  });

  it("rejects unsupported and unsafe trigger paths", async () => {
    const cwd = await temporaryDirectory();
    const directory = path.join(cwd, ".paseo", "triggers");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(cwd, "outside.yml"), "name: outside\n");
    await symlink(path.join(cwd, "outside.yml"), path.join(directory, "linked.yml"));

    await expect(discoverHubTriggers(cwd)).rejects.toMatchObject({
      code: "HUB_TRIGGER_UNSAFE_PATH",
    });
  });

  it("requires at least one trigger", async () => {
    const cwd = await temporaryDirectory();
    await mkdir(path.join(cwd, ".paseo", "triggers"), { recursive: true });

    await expect(discoverHubTriggers(cwd)).rejects.toMatchObject({ code: "HUB_TRIGGER_MISSING" });
  });

  it("directs legacy bundles to the explicit project deployment path", async () => {
    const cwd = await temporaryDirectory();
    await mkdir(path.join(cwd, ".paseo"));
    await writeFile(path.join(cwd, ".paseo", "hub.yml"), "environments: {}\n");

    await expect(discoverHubTriggers(cwd)).rejects.toMatchObject({
      code: "HUB_PROJECT_REQUIRED",
      message:
        "This directory contains a legacy .paseo/hub.yml bundle. Pass --project <slug> to deploy it.",
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-hub-triggers-"));
  temporaryDirectories.push(directory);
  return directory;
}
