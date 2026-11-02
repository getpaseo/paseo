import { expect, test } from "../support/fixtures";
import { withNewWorkspaceIssuesExample } from "../support/helpers/plugin-new-workspace-items";

for (const layout of [
  { name: "desktop", compact: false },
  { name: "compact", compact: true },
]) {
  test(`a plugin's New workspace item sets the branch and metadata on ${layout.name}`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await withNewWorkspaceIssuesExample(page, { compact: layout.compact }, async (screen) => {
      await screen.chooseWorktree();
      await screen.chooseIssue("PAS-102 Crash on resume");
      const created = await screen.createWorkspace();
      expect(created.branch).toBe("pas-102-crash-on-resume");
      expect(created.metadata).toEqual({ "new-workspace-issues.issue": "PAS-102" });
    });
  });
}

test("a branch chosen while Local applies once the user switches to a new worktree", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await withNewWorkspaceIssuesExample(page, { compact: false }, async (screen) => {
    await screen.chooseIssue("PAS-101 Slow sidebar");
    await screen.chooseWorktree();
    const created = await screen.createWorkspace({ prompt: "" });
    expect(created.branch).toBe("pas-101-slow-sidebar");
    expect(created.metadata).toEqual({ "new-workspace-issues.issue": "PAS-101" });
  });
});

test("a plugin's branch applies when the project has no default base to branch off", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await withNewWorkspaceIssuesExample(
    page,
    { compact: false, detachedHead: true },
    async (screen) => {
      await screen.chooseWorktree();
      await screen.chooseIssue("PAS-101 Slow sidebar");
      const created = await screen.createWorkspace();
      expect(created.branch).toBe("pas-101-slow-sidebar");
    },
  );
});

test("a branch and metadata chosen for one project are not sent for another", async ({ page }) => {
  test.setTimeout(180_000);
  await withNewWorkspaceIssuesExample(
    page,
    { compact: false, otherProject: true },
    async (screen) => {
      await screen.chooseWorktree();
      await screen.chooseIssue("PAS-101 Slow sidebar");
      await screen.switchToOtherProject();
      const created = await screen.createWorkspace();
      expect(created.branch).not.toBe("pas-101-slow-sidebar");
      expect(created.metadata ?? {}).toEqual({});
    },
  );
});

test("an isolation set from a mount effect is remembered like a pick", async ({ page }) => {
  test.setTimeout(180_000);
  await withNewWorkspaceIssuesExample(
    page,
    { compact: false, setsOnMount: true },
    async (screen) => {
      await screen.expectIsolation("worktree");
      await screen.reopenWithoutPlugin();
      await screen.expectIsolation("worktree");
    },
  );
});

test("an item can set the branch and metadata from its mount effect", async ({ page }) => {
  test.setTimeout(180_000);
  await withNewWorkspaceIssuesExample(
    page,
    { compact: false, setsOnMount: true },
    async (screen) => {
      await screen.expectIsolation("worktree");
      const created = await screen.createWorkspace();
      expect(created.branch).toBe("set-on-mount");
      expect(created.metadata).toEqual({ "new-workspace-issues.issue": "ON-MOUNT" });
    },
  );
});
