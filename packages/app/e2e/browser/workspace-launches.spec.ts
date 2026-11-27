import { test } from "../support/fixtures";
import {
  verifyConfiguredWorkspaceLaunches,
  verifyWorkspaceLaunchErrorRecovery,
} from "../support/helpers/workspace-launches";

test("configured launches appear in the shared workspace run menu", async ({ page }) => {
  test.setTimeout(90_000);
  await verifyConfiguredWorkspaceLaunches(page, test.info());
});

test("launch errors persist until users dismiss them or retry successfully", async ({ page }) => {
  test.setTimeout(90_000);
  await verifyWorkspaceLaunchErrorRecovery(page);
});
