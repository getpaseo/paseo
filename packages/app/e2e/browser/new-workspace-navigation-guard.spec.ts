import { test } from "../support/fixtures";
import { verifyDelayedWorkspaceCreation } from "../support/helpers/new-workspace-navigation";

test.describe("Delayed workspace creation", () => {
  test.describe.configure({ timeout: 120_000 });

  // Exercise each submit handler's navigation guard. Checkout isolation shares
  // those handlers; ordinary successful launches live in the creation journeys.
  test("chat worktree creation keeps the workspace chosen while it was pending", async ({
    page,
  }) => {
    await verifyDelayedWorkspaceCreation(page, "chat", "leave", "worktree");
  });

  test("terminal creation keeps the workspace chosen while it was pending", async ({ page }) => {
    await verifyDelayedWorkspaceCreation(page, "terminal", "leave");
  });

  test("empty creation keeps the workspace chosen while it was pending", async ({ page }) => {
    await verifyDelayedWorkspaceCreation(page, "empty", "leave");
  });

  test("preserves a newer draft opened while creation is pending", async ({ page }) => {
    await verifyDelayedWorkspaceCreation(page, "chat", "new-draft");
  });
});
