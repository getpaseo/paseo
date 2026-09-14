import { test } from "../support/fixtures";
import { verifyDelayedWorkspaceCreation } from "../support/helpers/new-workspace-navigation";

test.describe("Delayed workspace creation", () => {
  test.describe.configure({ timeout: 120_000 });

  for (const launch of ["chat", "terminal", "empty"] as const) {
    test(`${launch}: keeps the workspace chosen during creation`, async ({ page }) => {
      await verifyDelayedWorkspaceCreation(page, launch, "leave");
    });
    test(`worktree ${launch}: keeps the workspace chosen during creation`, async ({ page }) => {
      await verifyDelayedWorkspaceCreation(page, launch, "leave", "worktree");
    });
    test(`${launch}: opens the created workspace when the user stays`, async ({ page }) => {
      await verifyDelayedWorkspaceCreation(page, launch, "stay");
    });
  }

  test("preserves a newer draft opened while creation is pending", async ({ page }) => {
    await verifyDelayedWorkspaceCreation(page, "chat", "new-draft");
  });
});
