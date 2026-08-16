import { once } from "node:events";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import type { BoundWorkspaceRuntime } from "../../../workspace-runtime/index.js";
import { createWorkspaceRuntimeService } from "../../../workspace-runtime/index.js";
import { bindProviderWorkspace, resolveProviderPlacementPolicy } from "./index.js";

const posixDescribe = describe.runIf(process.platform !== "win32");

posixDescribe("provider workspace placement capability", () => {
  test("derives provider environment and host services from capabilities, not runtime ids", () => {
    expect(
      resolveProviderPlacementPolicy({
        capability: {
          environment: "isolated",
          sharedHostProviders: new Set(["fixture-host-service"]),
        },
        hostEnvironment: { HOST_ONLY: "secret" },
      }),
    ).toEqual({
      environment: { type: "isolated" },
      sharedHostProviders: new Set(["fixture-host-service"]),
    });
  });

  test("streams large binary state without putting content in argv and removes it safely", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-provider-state-"));
    const cwd = path.join(root, "workspace");
    await import("node:fs/promises").then((fs) => fs.mkdir(cwd));
    const runtimeIds = new Map<string, string>();
    const service = createWorkspaceRuntimeService({
      paseoHome: path.join(root, "paseo-home"),
      resolveRuntimeId: async (workspaceId) => runtimeIds.get(workspaceId) ?? null,
      persistRuntimeId: async (workspaceId, runtimeId) => runtimeIds.set(workspaceId, runtimeId),
      ...lifecycleRecords(runtimeIds),
    });
    await service.create({
      workspaceId: "provider-state",
      runtimeId: "local",
      project: { id: "project", source: { kind: "host-directory", path: cwd } },
      placement: { kind: "existing" },
    });
    const launches: Array<readonly string[]> = [];
    const bound = await service.bind("provider-state");
    const recordingRuntime: BoundWorkspaceRuntime = {
      provider: { environment: "isolated", sharedHostProviders: new Set() },
      ...bound,
      resolveCommand(command) {
        return command === "node"
          ? Promise.resolve(process.execPath)
          : bound.resolveCommand(command);
      },
      run(input) {
        launches.push(input.argv);
        return bound.run(input);
      },
    };
    const workspace = bindProviderWorkspace({
      runtime: recordingRuntime,
      cwd: ".",
      policy: {
        environment: { type: "inherit-sanitized-host", hostEnvironment: process.env },
        sharedHostProviders: new Set(),
      },
    });
    const contents = Buffer.alloc(192 * 1024, 0xa5);

    try {
      const stateFile = await workspace.materializeStateFile({
        name: "large-image.bin",
        content: contents,
      });
      expect(await readFile(path.join(cwd, stateFile.path))).toEqual(contents);
      expect(launches.flat().join(" ")).not.toContain(contents.toString("base64"));

      await stateFile.remove();
      await expect(access(path.join(cwd, stateFile.path))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await service.destroy("provider-state");
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects absolute, traversal, and escaping-symlink state removal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-provider-remove-"));
    const cwd = path.join(root, "workspace");
    await import("node:fs/promises").then((fs) => fs.mkdir(cwd));
    const runtimeIds = new Map<string, string>();
    const service = createWorkspaceRuntimeService({
      paseoHome: path.join(root, "paseo-home"),
      resolveRuntimeId: async (workspaceId) => runtimeIds.get(workspaceId) ?? null,
      persistRuntimeId: async (workspaceId, runtimeId) => runtimeIds.set(workspaceId, runtimeId),
      ...lifecycleRecords(runtimeIds),
    });
    await service.create({
      workspaceId: "provider-remove",
      runtimeId: "local",
      project: { id: "project", source: { kind: "host-directory", path: cwd } },
      placement: { kind: "existing" },
    });
    const workspace = bindProviderWorkspace({
      runtime: {
        ...(await service.bind("provider-remove")),
        resolveCommand: async (command) =>
          command === "node"
            ? process.execPath
            : (await service.bind("provider-remove")).resolveCommand(command),
      },
      cwd: ".",
      policy: {
        environment: { type: "inherit-sanitized-host", hostEnvironment: process.env },
        sharedHostProviders: new Set(),
      },
    });
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "outside");
    const stateDirectory = path.join(cwd, ".paseo", "provider-state");
    await import("node:fs/promises").then((fs) => fs.mkdir(stateDirectory, { recursive: true }));
    const escapeLink = path.join(stateDirectory, "escape-link");
    await symlink(outside, escapeLink);
    const relativeLink = path.relative(cwd, escapeLink);

    try {
      await expect(workspace.removeStateFile(outside)).rejects.toThrow(/relative|outside/i);
      await expect(workspace.removeStateFile("../outside.txt")).rejects.toThrow(
        /relative|outside/i,
      );
      await expect(workspace.removeStateFile(relativeLink)).rejects.toThrow(/outside|symlink/i);
      await expect(readFile(outside, "utf8")).resolves.toBe("outside");
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await service.destroy("provider-remove");
      await rm(root, { recursive: true, force: true });
    }
  });

  test("aborting a deferred selected launch kills the real process and settles its exit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-provider-abort-"));
    const cwd = path.join(root, "workspace");
    await import("node:fs/promises").then((fs) => fs.mkdir(cwd));
    const runtimeIds = new Map<string, string>();
    const service = createWorkspaceRuntimeService({
      paseoHome: path.join(root, "paseo-home"),
      resolveRuntimeId: async (workspaceId) => runtimeIds.get(workspaceId) ?? null,
      persistRuntimeId: async (workspaceId, runtimeId) => runtimeIds.set(workspaceId, runtimeId),
      ...lifecycleRecords(runtimeIds),
    });
    await service.create({
      workspaceId: "provider-abort",
      runtimeId: "local",
      project: { id: "project", source: { kind: "host-directory", path: cwd } },
      placement: { kind: "existing" },
    });
    const workspace = bindProviderWorkspace({
      runtime: {
        ...(await service.bind("provider-abort")),
        resolveCommand: async (command) =>
          command === "node"
            ? process.execPath
            : (await service.bind("provider-abort")).resolveCommand(command),
      },
      cwd: ".",
      policy: {
        environment: { type: "inherit-sanitized-host", hostEnvironment: process.env },
        sharedHostProviders: new Set(),
      },
    });
    const controller = new AbortController();
    const child = workspace.launchDeferred(
      Promise.resolve({
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write(`${process.pid}\\n`);setInterval(()=>{},1000)",
        ],
        purpose: { kind: "agent", agentId: "abort-agent", provider: "claude" },
        signal: controller.signal,
      }),
    );
    child.on("error", () => undefined);

    try {
      const [pidChunk] = (await once(child.stdout, "data")) as [Buffer];
      const pid = Number(pidChunk.toString().trim());
      controller.abort();
      const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
      expect({ code, signal }).toEqual({ code: null, signal: "SIGTERM" });
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      child.kill("SIGKILL");
      await service.destroy("provider-abort");
      await rm(root, { recursive: true, force: true });
    }
  });

  test("distinguishes missing provider state from a paused runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-provider-state-error-"));
    const cwd = path.join(root, "workspace");
    await import("node:fs/promises").then((fs) => fs.mkdir(cwd));
    const runtimeIds = new Map<string, string>();
    const service = createWorkspaceRuntimeService({
      paseoHome: path.join(root, "paseo-home"),
      resolveRuntimeId: async (workspaceId) => runtimeIds.get(workspaceId) ?? null,
      persistRuntimeId: async (workspaceId, runtimeId) => runtimeIds.set(workspaceId, runtimeId),
      ...lifecycleRecords(runtimeIds),
    });
    await service.create({
      workspaceId: "provider-state-error",
      runtimeId: "local",
      project: { id: "project", source: { kind: "host-directory", path: cwd } },
      placement: { kind: "existing" },
    });
    const workspace = bindProviderWorkspace({
      runtime: await service.bind("provider-state-error"),
      cwd: ".",
      policy: {
        environment: { type: "inherit-sanitized-host", hostEnvironment: process.env },
        sharedHostProviders: new Set(),
      },
    });

    try {
      await expect(
        workspace.findStateFile(
          `.paseo/provider-state/missing-${process.pid}-${Date.now()}`,
          "missing.jsonl",
        ),
      ).resolves.toBeNull();
      await service.pause("provider-state-error");
      await expect(
        workspace.findStateFile(".claude/projects", "selected-runtime.jsonl"),
      ).rejects.toThrow(/runtime is paused/i);
    } finally {
      await service.destroy("provider-state-error");
      await rm(root, { recursive: true, force: true });
    }
  });
});

function lifecycleRecords(runtimeIds: Map<string, string>) {
  return {
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async (workspaceId: string) => {
      runtimeIds.delete(workspaceId);
    },
  };
}
