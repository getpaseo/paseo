import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { DaemonClient } from "../../../../server/src/server/test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../../../../server/src/server/test-utils/paseo-daemon.js";
import { buildWorkspaceSource, runCreateCommand } from "./create.js";

describe("workspace create source", () => {
  it("maps local isolation to a directory workspace", () => {
    expect(
      buildWorkspaceSource({ isolation: "local", path: "/tmp/project", project: "project-1" }),
    ).toEqual({ kind: "directory", path: "/tmp/project", projectId: "project-1" });
  });

  it("keeps branch names separate from managed worktree slugs", () => {
    expect(
      buildWorkspaceSource({
        isolation: "worktree",
        path: "/tmp/project",
        mode: "branch-off",
        newBranch: "feature/auth",
        worktreeSlug: "feature-auth",
        base: "main",
      }),
    ).toEqual({
      kind: "worktree",
      cwd: "/tmp/project",
      action: "branch-off",
      branchName: "feature/auth",
      worktreeSlug: "feature-auth",
      baseBranch: "main",
    });
  });

  it("uses a project as the worktree source without capturing the ambient directory", () => {
    expect(
      buildWorkspaceSource({
        isolation: "worktree",
        project: "project-1",
        mode: "branch-off",
        newBranch: "fix-x",
      }),
    ).toEqual({
      kind: "worktree",
      projectId: "project-1",
      action: "branch-off",
      branchName: "fix-x",
    });
  });

  it("checks out an existing branch into a worktree workspace", () => {
    expect(
      buildWorkspaceSource({
        isolation: "worktree",
        path: "/tmp/project",
        mode: "checkout-branch",
        branch: "existing-work",
        worktreeSlug: "existing-work-copy",
      }),
    ).toEqual({
      kind: "worktree",
      cwd: "/tmp/project",
      action: "checkout",
      refName: "existing-work",
      worktreeSlug: "existing-work-copy",
    });
  });

  it("checks out a pull request into a worktree workspace", () => {
    expect(
      buildWorkspaceSource({
        isolation: "worktree",
        path: "/tmp/project",
        mode: "checkout-pr",
        prNumber: "42",
        forge: "gitlab",
      }),
    ).toEqual({
      kind: "worktree",
      cwd: "/tmp/project",
      action: "checkout",
      checkoutSource: {
        kind: "change_request",
        forge: "gitlab",
        number: 42,
      },
    });
  });

  it("lets the source checkout select the forge when it is omitted", () => {
    expect(
      buildWorkspaceSource({
        isolation: "worktree",
        path: "/tmp/project",
        mode: "checkout-pr",
        prNumber: "42",
      }),
    ).toEqual({
      kind: "worktree",
      cwd: "/tmp/project",
      action: "checkout",
      checkoutSource: {
        kind: "change_request",
        number: 42,
      },
    });
  });

  it("requires the mode-specific checkout target", () => {
    expect(() => buildWorkspaceSource({ isolation: "worktree", mode: "checkout-branch" })).toThrow(
      "--branch is required",
    );
    expect(() => buildWorkspaceSource({ isolation: "worktree", mode: "checkout-pr" })).toThrow(
      "--pr-number is required",
    );
  });

  it("rejects worktree options for local isolation", () => {
    expect(() => buildWorkspaceSource({ isolation: "local", mode: "branch-off" })).toThrow(
      "Worktree options require --isolation worktree",
    );
  });

  it("rejects unknown isolation", () => {
    expect(() => buildWorkspaceSource({ isolation: "container" })).toThrow(
      "Unsupported workspace isolation",
    );
  });
});

describe("workspace create caller context", () => {
  it("inherits only callers on the selected daemon and preserves explicit visibility", async () => {
    const daemon = await createTestPaseoDaemon({
      providerOverrides: { codex: { enabled: true } },
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    const previousCaller = process.env.PASEO_AGENT_ID;
    const previousHome = process.env.PASEO_HOME;
    try {
      process.env.PASEO_HOME = daemon.paseoHome;
      await client.connect();
      const parentWorkspace = await client.createWorkspace({
        source: { kind: "directory", path: daemon.paseoHome },
        background: true,
      });
      expect(parentWorkspace.error).toBeNull();
      const parent = await client.createAgent({
        config: { provider: "codex", cwd: daemon.paseoHome },
        workspaceId: parentWorkspace.workspace!.id,
      });
      const cases = [
        { caller: parent.id, background: undefined, expected: true },
        { caller: parent.id, background: false, expected: false },
        { caller: parent.id, background: true, expected: true },
        { caller: "foreign-or-missing-agent", background: undefined, expected: false },
        { caller: "foreign-or-missing-agent", background: true, expected: true },
        { caller: "foreign-or-missing-agent", background: false, expected: false },
        { caller: "", background: undefined, expected: false },
        { caller: "", background: true, expected: true },
      ];
      for (const entry of cases) {
        process.env.PASEO_AGENT_ID = entry.caller;
        const result = await runCreateCommand(
          {
            daemonTarget: { kind: "endpoint", host: `127.0.0.1:${daemon.port}` },
            isolation: "local",
            path: daemon.paseoHome,
            ...(entry.background !== undefined ? { background: entry.background } : {}),
          },
          new Command(),
        );
        expect(result.data.background, JSON.stringify(entry)).toBe(entry.expected);
      }
    } finally {
      if (previousCaller === undefined) delete process.env.PASEO_AGENT_ID;
      else process.env.PASEO_AGENT_ID = previousCaller;
      if (previousHome === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = previousHome;
      await client.close();
      await daemon.close();
    }
  }, 30_000);
});
