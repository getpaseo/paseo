import { expect, test } from "../../app/e2e/support/fixtures";
import { gotoAppShell, openSettings } from "../../app/e2e/support/helpers/app";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import {
  openAddHostFlow,
  selectHostConnectionType,
  toggleHostAdvanced,
} from "../../app/e2e/support/helpers/settings";
import { installDesktopRuntime } from "./support/runtime";

test("Electron users can add and remove direct connection custom headers", async ({ page }) => {
  await installDesktopRuntime(page, { serverId: getServerId() });
  await gotoAppShell(page);
  await openSettings(page);
  await openAddHostFlow(page);
  await selectHostConnectionType(page, "direct");
  await toggleHostAdvanced(page);

  const addHeader = page.getByTestId("direct-header-add");
  await expect(addHeader).toBeVisible();
  await addHeader.click();

  await page.getByTestId("direct-header-name-0").fill("X-Tenant");
  await page.getByTestId("direct-header-value-0").fill("acme");
  await expect(page.getByTestId("direct-header-name-0")).toHaveValue("X-Tenant");
  await expect(page.getByTestId("direct-header-value-0")).toHaveValue("acme");

  await page.getByTestId("direct-header-remove-0").click();
  await expect(page.getByTestId("direct-header-name-0")).toHaveCount(0);
  await expect(page.getByTestId("direct-header-value-0")).toHaveCount(0);
});
