import { PassThrough, Readable } from "node:stream";

import { expect, test, vi } from "vitest";

import { observeWorkspaceGit } from "../../../workspace-git-observation.js";
import type { BoundWorkspaceRuntime } from "../../index.js";
import type { WorkspaceRuntimeDriver } from "../../drivers/index.js";
import { createGitCommonObservationCoordinator } from "./integration.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("selected runtime Git observation prunes paths ignored by that runtime checkout", async () => {
  let subscriptionInput: Parameters<BoundWorkspaceRuntime["files"]["subscribe"]>[0] | null = null;
  const run = vi.fn(async () => ({
    stdin: new PassThrough(),
    stdout: Readable.from(["node_modules/\0packages/server/dist/\0"]),
    stderr: Readable.from([]),
    exited: Promise.resolve({ code: 0, signal: null }),
    kill: () => undefined,
  }));
  const resolveCommand = vi.fn(async () => "C:\\runtime\\git.exe");
  const runtime = {
    run,
    resolveCommand,
    scriptTerminal: { kind: "direct-command", command: "/bin/sh", argsPrefix: ["-lc"] },
    files: {
      subscribe: async (input) => {
        subscriptionInput = input;
        return { unsubscribe: async () => undefined };
      },
    },
  } as unknown as BoundWorkspaceRuntime;
  const coordinator = createGitCommonObservationCoordinator();
  coordinator.bind(runtime, "workspace-1", {} as WorkspaceRuntimeDriver);

  const subscription = await observeWorkspaceGit(runtime, () => undefined);

  expect(subscriptionInput).toEqual({
    paths: ["."],
    recursive: true,
    ignoredPaths: ["node_modules", "packages/server/dist"],
  });
  expect(resolveCommand).toHaveBeenCalledWith("git");
  expect(run).toHaveBeenCalledWith({
    argv: [
      "C:\\runtime\\git.exe",
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ],
    env: { GIT_OPTIONAL_LOCKS: "0" },
    purpose: { kind: "git" },
  });
  await subscription.unsubscribe();
});

test("selected runtime Git observation stays available when Git is unavailable", async () => {
  let subscriptionInput: Parameters<BoundWorkspaceRuntime["files"]["subscribe"]>[0] | null = null;
  const runtime = {
    run: vi.fn(),
    resolveCommand: vi.fn(async () => null),
    scriptTerminal: { kind: "direct-command", command: "/bin/sh", argsPrefix: ["-lc"] },
    files: {
      subscribe: async (input) => {
        subscriptionInput = input;
        return { unsubscribe: async () => undefined };
      },
    },
  } as unknown as BoundWorkspaceRuntime;
  const coordinator = createGitCommonObservationCoordinator();
  coordinator.bind(runtime, "workspace-1", {} as WorkspaceRuntimeDriver);

  const subscription = await observeWorkspaceGit(runtime, () => undefined);

  expect(subscriptionInput).toEqual({ paths: ["."], recursive: true, ignoredPaths: [] });
  expect(runtime.run).not.toHaveBeenCalled();
  await subscription.unsubscribe();
});

test("closing Git observation waits for and releases an in-flight acquisition", async () => {
  const physicalUnsubscribe = vi.fn(async () => {});
  const physical = createDeferred<{ unsubscribe(): Promise<void> }>();
  const workingTreeUnsubscribe = vi.fn(async () => {});
  const runtime = {
    files: {
      subscribe: vi.fn(async () => ({ unsubscribe: workingTreeUnsubscribe })),
    },
  } as unknown as BoundWorkspaceRuntime;
  const driver = {
    observeGit: vi.fn(() => physical.promise),
  } as unknown as WorkspaceRuntimeDriver;
  const coordinator = createGitCommonObservationCoordinator();
  coordinator.bind(runtime, "workspace-1", driver);

  const observation = observeWorkspaceGit(runtime, () => undefined);
  await vi.waitFor(() => expect(driver.observeGit).toHaveBeenCalledTimes(1));
  const closing = coordinator.close();
  expect(coordinator.close()).toBe(closing);
  expect(
    await Promise.race([
      closing.then(() => "closed" as const),
      Promise.resolve("pending" as const),
    ]),
  ).toBe("pending");

  physical.resolve({ unsubscribe: physicalUnsubscribe });
  await expect(observation).rejects.toThrow("Git common observation coordinator is closed");
  await closing;
  expect(physicalUnsubscribe).toHaveBeenCalledTimes(1);
  expect(workingTreeUnsubscribe).toHaveBeenCalledTimes(1);

  await expect(observeWorkspaceGit(runtime, () => undefined)).rejects.toThrow(
    "Git common observation coordinator is closed",
  );
  expect(driver.observeGit).toHaveBeenCalledTimes(1);
});
