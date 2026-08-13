import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "../support/fixtures";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

test("copies a whole opened file from the compact tab menu", async ({ context, page }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  const fileName = "architecture.md";
  const fileContents = "# Architecture\n\nA complete document for mobile review.\n";
  const session = await seedMockAgentWorkspace({
    repoPrefix: "workspace-file-actions-",
    title: "File actions",
  });

  try {
    await writeFile(path.join(session.cwd, fileName), fileContents, "utf8");
    await openAgentRoute(page, session);
    await openFileExplorer(page);
    await openFileFromExplorer(page, fileName);
    await expect(page.getByText("Architecture", { exact: true })).toBeVisible({ timeout: 30_000 });

    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.getByRole("button", { name: /Switch tabs/ }).click();
    const menuBase = `workspace-tab-menu-file_${fileName}`;
    await page.getByTestId(`${menuBase}-trigger`).click();

    const copyItem = page.getByTestId(`${menuBase}-copy-file-contents`);
    await expect(copyItem).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`${menuBase}-share-file`)).toBeVisible();
    await copyItem.click();

    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(fileContents);
  } finally {
    await session.cleanup();
  }
});
