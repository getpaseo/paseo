import { expect, test, vi } from "vitest";
import { bindLegacyWorkspaceGit, bindSelectedWorkspaceGit } from "./workspace-git";

test.each(["", "   "])(
  "the app selected Git boundary rejects workspaceId %j before binding a daemon client",
  (workspaceId) => {
    const bindWorkspaceGit = vi.fn();

    expect(() =>
      bindSelectedWorkspaceGit(
        { bindWorkspaceGit },
        { kind: "selected", workspaceId, cwd: "/shared" },
      ),
    ).toThrow("workspaceId is required for selected workspace Git");
    expect(bindWorkspaceGit).not.toHaveBeenCalled();
  },
);

test.each(["", "   "])(
  "the app selected Git boundary rejects cwd %j before binding a daemon client",
  (cwd) => {
    const bindWorkspaceGit = vi.fn();

    expect(() =>
      bindSelectedWorkspaceGit(
        { bindWorkspaceGit },
        { kind: "selected", workspaceId: "workspace-a", cwd },
      ),
    ).toThrow("cwd is required for selected workspace Git");
    expect(bindWorkspaceGit).not.toHaveBeenCalled();
  },
);

test("the app selected Git boundary normalizes its complete address once", () => {
  const bindWorkspaceGit = vi.fn(() => ({ workspaceId: "workspace-a", cwd: "/shared" }));

  const workspaceGit = bindSelectedWorkspaceGit({ bindWorkspaceGit } as never, {
    kind: "selected",
    workspaceId: " workspace-a ",
    cwd: " /shared ",
  });

  expect(bindWorkspaceGit).toHaveBeenCalledWith({ workspaceId: "workspace-a", cwd: "/shared" });
  expect(workspaceGit).toMatchObject({
    workspaceId: "workspace-a",
    cwd: "/shared",
    queryIdentity: ["selected", "workspace-a"],
  });
});

test("selected and legacy capabilities own structurally distinct query identities", () => {
  const selected = bindSelectedWorkspaceGit(
    {
      bindWorkspaceGit: () => ({ workspaceId: "legacy:/shared", cwd: "/shared" }),
    } as never,
    { kind: "selected", workspaceId: "legacy:/shared", cwd: "/shared" },
  );
  const legacy = bindLegacyWorkspaceGit(
    {
      checkoutPrStatus: vi.fn(),
      getCheckoutStatus: vi.fn(),
      searchForge: vi.fn(),
      searchGitHub: vi.fn(),
    },
    { kind: "legacy", cwd: "/shared" },
  );

  expect(selected.queryIdentity).toEqual(["selected", "legacy:/shared"]);
  expect(legacy.queryIdentity).toEqual(["legacy", "/shared"]);
  expect(selected.queryIdentity).not.toEqual(legacy.queryIdentity);
});
