import { expect } from "@playwright/test";
import { test } from "./fixtures";
import { gotoAppShell, openSettings } from "./helpers/app";
import { getServerId } from "./helpers/server-id";
import { openSettingsHost, openHostSection } from "./helpers/settings";

// Regression for #1602: pasting into the append-system-prompt field must enable Save.
test.describe("Append system prompt paste", () => {
  test("pasting into the field enables Save", async ({ page }) => {
    const serverId = getServerId();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHost(page, serverId);
    await openHostSection(page, serverId, "agents");

    await page.getByTestId("host-page-append-system-prompt-edit").click();

    const input = page.getByTestId("host-page-append-system-prompt-input");
    await expect(input).toBeVisible();

    const save = page.getByTestId("host-page-append-system-prompt-save");
    await expect(save).toBeDisabled();

    // Real clipboard paste (Cmd/Ctrl+V), the path the bug report describes.
    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text);
    }, "pasted system prompt");
    await input.click();
    await page.keyboard.press("ControlOrMeta+V");

    await expect(input).toHaveValue("pasted system prompt");
    await expect(save).toBeEnabled();
  });
});
