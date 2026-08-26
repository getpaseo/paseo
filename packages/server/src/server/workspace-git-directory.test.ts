import { resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { createWorkspaceGitDirectory } from "./workspace-git-directory.js";
import type { WorkspaceGitWorkspace } from "./workspace-git-service.js";

test("selected Git addresses cannot become legacy through empty or omitted identity", async () => {
  const cwd = "/shared";
  const selected = { cwd } as WorkspaceGitWorkspace;
  const legacy = { cwd } as WorkspaceGitWorkspace;
  const record = {
    workspaceId: "workspace-selected",
    cwd,
    hostVisiblePath: null,
    runtime: { runtimeId: "command" },
  };
  const get = vi.fn(async (workspaceId: string) =>
    workspaceId === record.workspaceId ? record : null,
  );
  const directory = createWorkspaceGitDirectory({
    workspaceRegistry: { get, list: async () => [record] },
    workspaceGitService: {
      bindWorkspace: () => selected,
      bindLegacy: () => legacy,
      releaseWorkspace: vi.fn(),
    },
  });

  for (const workspaceId of ["", "   "]) {
    await expect(directory.resolve({ kind: "selected", workspaceId, cwd })).rejects.toThrow(
      "workspaceId is required for selected workspace Git",
    );
  }
  await expect(directory.resolve({ kind: "legacy", cwd })).rejects.toThrow(
    "workspaceId is required for a selected workspace Git operation",
  );
  await expect(directory.resolve({ kind: "legacy", cwd: `${cwd}/nested` })).rejects.toThrow(
    "workspaceId is required for a selected workspace Git operation",
  );
  expect(get).not.toHaveBeenCalled();
});

test("selected virtual paths do not capture sibling legacy Git workspaces", async () => {
  const legacy = { cwd: "/workspace/project-copy" } as WorkspaceGitWorkspace;
  const bindLegacy = vi.fn(() => legacy);
  const record = {
    workspaceId: "workspace-selected",
    cwd: "/workspace/project",
    runtime: { runtimeId: "command" },
  };
  const directory = createWorkspaceGitDirectory({
    workspaceRegistry: { get: vi.fn(), list: async () => [record] },
    workspaceGitService: { bindWorkspace: vi.fn(), bindLegacy, releaseWorkspace: vi.fn() },
  });

  await expect(directory.resolve({ kind: "legacy", cwd: "/workspace/project-copy" })).resolves.toBe(
    legacy,
  );
  expect(bindLegacy).toHaveBeenCalledWith(resolve("/workspace/project-copy"));
});

test.each(["", "   "])(
  "selected Git addresses reject cwd %j before registry lookup",
  async (cwd) => {
    const get = vi.fn();
    const directory = createWorkspaceGitDirectory({
      workspaceRegistry: { get, list: vi.fn() },
      workspaceGitService: {
        bindWorkspace: vi.fn(),
        bindLegacy: vi.fn(),
        releaseWorkspace: vi.fn(),
      },
    });

    await expect(
      directory.resolve({ kind: "selected", workspaceId: "workspace-a", cwd }),
    ).rejects.toThrow("cwd is required for selected workspace Git");
    expect(get).not.toHaveBeenCalled();
  },
);

test("selected runtime addresses never fall back to host Git", async () => {
  const cwd = "/shared";
  const legacy = { cwd } as WorkspaceGitWorkspace;
  const record = {
    workspaceId: "workspace-local",
    cwd,
    hostVisiblePath: cwd,
    runtime: { runtimeId: "local" },
  };
  const bindLegacy = vi.fn(() => legacy);
  const directory = createWorkspaceGitDirectory({
    workspaceRegistry: { get: vi.fn(), list: async () => [record] },
    workspaceGitService: { bindWorkspace: vi.fn(), bindLegacy },
  });

  await expect(directory.resolve({ kind: "legacy", cwd })).rejects.toThrow(
    "workspaceId is required for a selected workspace Git operation",
  );
  expect(bindLegacy).not.toHaveBeenCalled();
});

test("selected Git addresses normalize both fields before registry lookup", async () => {
  const runtimeCwd = process.platform === "win32" ? "/workspace" : String.raw`C:\workspace`;
  const record = {
    workspaceId: "workspace-a",
    cwd: runtimeCwd,
    runtime: { runtimeId: "command" },
  };
  const get = vi.fn(async () => record);
  const selected = { cwd: record.cwd } as WorkspaceGitWorkspace;
  const bindWorkspace = vi.fn(() => selected);
  const directory = createWorkspaceGitDirectory({
    workspaceRegistry: { get, list: vi.fn() },
    workspaceGitService: { bindWorkspace, bindLegacy: vi.fn(), releaseWorkspace: vi.fn() },
  });

  await expect(
    directory.resolve({
      kind: "selected",
      workspaceId: " workspace-a ",
      cwd: ` ${runtimeCwd} `,
    }),
  ).resolves.toBe(selected);
  expect(get).toHaveBeenCalledWith("workspace-a");
  expect(bindWorkspace).toHaveBeenCalledWith({ workspaceId: "workspace-a", cwd: runtimeCwd });
});
