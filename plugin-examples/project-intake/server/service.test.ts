import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { ProjectIntakeService } from "./service";
import { preferences } from "../shared/preferences";
import { assessPolicy, projectName, validateProjectName } from "../shared/policy";
import type { AssessmentInput, ProjectDecision } from "../shared/contracts";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(
  decision: ProjectDecision = { choice: "new", confidence: 0.95 },
  initialize?: (directory: string, name: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "project-intake-"));
  directories.push(directory);
  const cwd = join(directory, "pandaos");
  await mkdir(cwd);
  let settings = preferences.schema.parse({});
  const decide = vi.fn(async () => decision);
  const options = {
    directory: join(directory, "state"),
    settings: async () => settings,
    decide,
    initialize,
  };
  const service = new ProjectIntakeService(options);
  const createDirectory = vi.fn(
    async ({ parentPath, name }: { parentPath: string; name: string }) => {
      const directoryPath = join(parentPath, name);
      await mkdir(directoryPath);
      return { directoryPath, project: { projectId: "project-kin" }, error: null, errorCode: null };
    },
  );
  const paseo = { projects: { createDirectory } } as unknown as PaseoApi;
  const input: AssessmentInput = {
    cwd,
    projectRootPath: cwd,
    projectName: "PandaOS",
    text: "Build Kin product from KIN-001/002",
    executionId: "kitchen",
    idempotencyKey: "original-request",
  };
  return {
    directory,
    cwd,
    input,
    service,
    decide,
    createDirectory,
    paseo,
    options,
    changeSettings: (values: Record<string, unknown>) => {
      settings = preferences.schema.parse({ ...settings, ...values });
    },
  };
}

test("greetings and high-confidence fitting requests start without a project question", async () => {
  const f = await fixture({ choice: "current", confidence: 0.95 });
  expect((await f.service.assess({ ...f.input, text: "hi" })).showDecision).toBe(false);
  expect(f.decide).not.toHaveBeenCalled();
  expect(
    (
      await f.service.assess({
        ...f.input,
        idempotencyKey: "second",
        text: "Fix the PandaOS composer button",
      })
    ).showDecision,
  ).toBe(false);
  expect(f.createDirectory).not.toHaveBeenCalled();
});

test("a mismatching product is offered with a60s deadline before any project is created", async () => {
  const f = await fixture();
  expect(await f.service.assess(f.input)).toMatchObject({
    currentName: "PandaOS",
    proposedName: "kin",
    recommendation: "new",
    timeout: { seconds: 60, choiceId: "new" },
  });
  expect(f.createDirectory).not.toHaveBeenCalled();
  await expect(
    f.service.resolve(
      { idempotencyKey: f.input.idempotencyKey, choiceId: "new", automatic: true },
      f.paseo,
    ),
  ).rejects.toThrow("timer has not finished");
  for (const name of ["CON", "AUX", "PRN"]) {
    expect(
      await f.service.assess({ ...f.input, idempotencyKey: name, text: `Build ${name} product` }),
    ).toMatchObject({ proposedName: "new-product", timeout: { choiceId: "current" } });
  }
  expect(f.createDirectory).not.toHaveBeenCalled();
});

test("new project creates only its own Git history and repeated selection is durable", async () => {
  const f = await fixture();
  await f.service.assess(f.input);
  const choice = {
    idempotencyKey: f.input.idempotencyKey,
    choiceId: "new" as const,
    automatic: false,
    textValue: "kin",
  };
  const target = await f.service.resolve(choice, f.paseo);
  expect(target).toEqual({ cwd: join(f.directory, "kin"), projectId: "project-kin" });
  const execute = promisify(execFile);
  const { stdout } = await execute("git", ["rev-parse", "--show-toplevel"], { cwd: target!.cwd });
  expect(stdout.trim()).toBe(target!.cwd);
  expect(await readFile(join(target!.cwd, "README.md"), "utf8")).toContain("# kin");
  expect(await new ProjectIntakeService(f.options).resolve(choice, f.paseo)).toEqual(target);
  expect(f.createDirectory).toHaveBeenCalledTimes(1);
  await expect(readFile(join(f.cwd, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("keeping the selected project performs no project creation", async () => {
  const f = await fixture();
  await f.service.assess(f.input);
  expect(
    await f.service.resolve(
      { idempotencyKey: f.input.idempotencyKey, choiceId: "current", automatic: false },
      f.paseo,
    ),
  ).toBeNull();
  expect(f.createDirectory).not.toHaveBeenCalled();
});

test("unavailable or uncertain Jev keeps the current project as the timed default", async () => {
  const settings = preferences.schema.parse({});
  for (const decision of [
    undefined,
    { choice: "new" as const, confidence: 0.5 },
    { choice: "uncertain" as const, confidence: 1 },
  ]) {
    expect(
      assessPolicy({
        text: "Build Kin product",
        currentName: "PandaOS",
        parentPath: "/projects",
        preferences: settings,
        decision,
      }),
    ).toMatchObject({
      showDecision: true,
      recommendation: "current",
      timeout: { choiceId: "current" },
    });
  }
});

test("wait mode leaves the project question pending and automatic action respects updated settings", async () => {
  const f = await fixture();
  f.changeSettings({ unansweredAction: "wait" });
  expect((await f.service.assess(f.input)).timeout).toBeUndefined();
  await expect(
    f.service.resolve(
      { idempotencyKey: f.input.idempotencyKey, choiceId: "new", automatic: true },
      f.paseo,
    ),
  ).rejects.toThrow("configured recommendation");
  expect(f.createDirectory).not.toHaveBeenCalled();
});

test("automatic choice runs only after the saved deadline and cannot choose a different action", async () => {
  const f = await fixture(undefined, async () => {});
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  await f.service.assess(f.input);
  clock.mockReturnValue(now + 60001);
  await expect(
    f.service.resolve(
      { idempotencyKey: f.input.idempotencyKey, choiceId: "current", automatic: true },
      f.paseo,
    ),
  ).rejects.toThrow("configured recommendation");
  expect(
    await f.service.resolve(
      { idempotencyKey: f.input.idempotencyKey, choiceId: "new", automatic: true },
      f.paseo,
    ),
  ).toMatchObject({ projectId: "project-kin" });
});

test("changing preferences cancels a pending automatic new project choice", async () => {
  const f = await fixture(undefined, async () => {});
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  await f.service.assess(f.input);
  clock.mockReturnValue(Date.now() + 60001);
  const choice = {
    idempotencyKey: f.input.idempotencyKey,
    choiceId: "new" as const,
    automatic: true,
  };
  for (const values of [
    { enabled: false },
    { enabled: true, unansweredAction: "wait" },
    { enabled: true, unansweredAction: "current" },
  ]) {
    f.changeSettings(values);
    await expect(f.service.resolve(choice, f.paseo)).rejects.toThrow("Automatic project selection");
  }
  expect(f.createDirectory).not.toHaveBeenCalled();
});

test("a canceled draft can be edited while path-like names are rejected before directory mutation", async () => {
  const f = await fixture();
  await f.service.assess(f.input);
  const edited = { ...f.input, text: "Build Lin product" };
  expect((await f.service.assess(edited)).proposedName).toBe("lin");
  expect(f.decide).toHaveBeenCalledTimes(2);
  await expect(
    f.service.resolve(
      {
        idempotencyKey: f.input.idempotencyKey,
        choiceId: "new",
        textValue: "../pandaos",
        automatic: false,
      },
      f.paseo,
    ),
  ).rejects.toThrow("short project name");
  expect(f.createDirectory).not.toHaveBeenCalled();
  for (const name of ["../pandaos", "a/b", "CON", ""])
    expect(() => validateProjectName(name)).toThrow();
  expect(projectName("build kin product")).toBe("kin");
  await f.service.resolve(
    { idempotencyKey: f.input.idempotencyKey, choiceId: "new", automatic: false, textValue: "lin" },
    f.paseo,
  );
  await expect(f.service.assess(f.input)).rejects.toThrow("request changed");
});

test("initialization failure retains the created identity for a safe retry after plugin reload", async () => {
  const initialize = vi
    .fn()
    .mockRejectedValueOnce(new Error("Git not available"))
    .mockResolvedValue(undefined);
  const f = await fixture(undefined, initialize);
  await f.service.assess(f.input);
  const choice = {
    idempotencyKey: f.input.idempotencyKey,
    choiceId: "new" as const,
    automatic: false,
  };
  await expect(f.service.resolve(choice, f.paseo)).rejects.toThrow("Git not available");
  await expect(new ProjectIntakeService(f.options).resolve(choice, f.paseo)).resolves.toMatchObject(
    { projectId: "project-kin" },
  );
  expect(f.createDirectory).toHaveBeenCalledTimes(1);
});
