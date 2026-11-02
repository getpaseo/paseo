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
