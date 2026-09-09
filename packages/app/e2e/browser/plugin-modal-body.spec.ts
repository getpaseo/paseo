import { copyPluginExample } from "../support/helpers/plugin-fixture";
import { expect, test as base, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import {
  openMobileAgentSidebar,
  expectMobileAgentSidebarVisible,
} from "../support/helpers/sidebar";

async function openExample(page: Page, example: string) {
  await page.getByRole("button", { name: `Open ${example}`, exact: true }).click();
  await expect(page.getByText(`Modal example: ${example}`, { exact: true })).toBeVisible();
}

async function closeExample(page: Page) {
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Open Form", exact: true })).toBeVisible();
}

async function copyAndPaste(page: Page) {
  await page.getByRole("button", { name: "Copy text", exact: true }).click();
  await expect(page.getByText("Text copied", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Copied from Paseo");
  await page.getByRole("textbox", { name: "Paste here" }).focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+V");
  await expect(page.getByRole("textbox", { name: "Paste here" })).toHaveValue("Copied from Paseo");
}

async function scrollToLastRow(page: Page) {
  await page.getByRole("button", { name: "Row 1", exact: true }).hover();
  await page.mouse.wheel(0, 7000);
  await expect(page.getByRole("button", { name: "Row 100", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Row 100", exact: true }).click();
}

async function expectSingleInset(page: Page, left = "24px", bottom = "24px") {
  const form = await page.getByTestId("modal-example-form").boundingBox();
  const input = await page.getByRole("textbox", { name: "Paste here" }).boundingBox();
  expect(form).not.toBeNull();
  expect(input?.x).toBe(form?.x);
  // The real content View owns the inset, not a third-party contentContainerStyle.
  const padding = await page.getByTestId("modal-example-form").evaluate((node) => {
    const content = node.parentElement!;
    return {
      left: getComputedStyle(content).paddingLeft,
      bottom: getComputedStyle(content).paddingBottom,
    };
  });
  expect(padding).toEqual({ left, bottom });
}

async function expectFullBleed(page: Page) {
  const padding = await page
    .getByRole("button", { name: "Row 1", exact: true })
    .evaluate((node) => {
      const content = node.parentElement!;
      return {
        left: getComputedStyle(content).paddingLeft,
        bottom: getComputedStyle(content).paddingBottom,
      };
    });
  expect(padding).toEqual({ left: "0px", bottom: "0px" });
}

async function exerciseBodies(page: Page) {
  await openExample(page, "Form");
  await expectSingleInset(page);
  await copyAndPaste(page);
  await closeExample(page);
  await openExample(page, "Custom inset");
  await expectSingleInset(page, "8px", "40px");
  await closeExample(page);
  await openExample(page, "Full bleed");
  await expectFullBleed(page);
  await scrollToLastRow(page);
  await closeExample(page);
  await openExample(page, "ScrollView");
  await scrollToLastRow(page);
  await closeExample(page);
  await openExample(page, "FlatList");
  await page.getByRole("button", { name: "Jump to last row", exact: true }).click();
  await expect(page.getByRole("button", { name: "Row 100", exact: true })).toBeInViewport();
  await closeExample(page);
  await openExample(page, "Horizontal");
  await page.getByRole("button", { name: "Overview", exact: true }).hover();
  await page.mouse.wheel(900, 0);
  await expect(page.getByRole("button", { name: "System logs", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "System logs", exact: true }).click();
  await closeExample(page);
  await expect(page.getByText("Selected: System logs", { exact: true })).toBeVisible();
}

const test = base.extend<{ modalExample: Page }>({
  modalExample: async ({ page, context }, provide) => {
    const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
    const previous = await client.getDaemonConfig();
    const example = await copyPluginExample("modal-ui");
    try {
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installDirectoryPlugin(example.directory);
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await provide(page);
    } finally {
      await client.removePlugin("modal-ui-example").catch(() => undefined);
      await client
        .patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false })
        .catch(() => undefined);
      await client.close().catch(() => undefined);
      await example.cleanup();
    }
  },
});

async function openWideExamples(page: Page) {
  await page.setViewportSize({ width: 1100, height: 800 });
  await gotoAppShell(page);
  await page.getByRole("button", { name: "Modal examples", exact: true }).click();
}

async function openCompactExamples(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await openMobileAgentSidebar(page);
  await expectMobileAgentSidebarVisible(page);
  await page.getByRole("button", { name: "Modal examples", exact: true }).click();
}

async function expectDeniedCopyFeedback(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    await cdp.send("Browser.setPermission", {
      browserContextId: targetInfo.browserContextId,
      permission: { name: "clipboard-write" },
      setting: "denied",
      origin: new URL(page.url()).origin,
    });
    expect(
      await page.evaluate(
        async () =>
          (await navigator.permissions.query({ name: "clipboard-write" as PermissionName })).state,
      ),
    ).toBe("denied");
    await openExample(page, "Form");
    await page.getByRole("button", { name: "Copy text", exact: true }).click();
    await expect(
      page.getByText("Could not copy text. Select the text and use Copy.", { exact: true }),
    ).toBeVisible();
    await closeExample(page);
  } finally {
    await cdp.detach();
  }
}

test("plugin bodies support padding, scroll ownership, horizontal tabs and clipboard on wide and compact layouts", async ({
  modalExample: page,
}) => {
  await openWideExamples(page);
  await test.step("wide dialogs", () => exerciseBodies(page));
  await openCompactExamples(page);
  await test.step("compact sheets", () => exerciseBodies(page));
  await test.step("denied clipboard writes report failure", () => expectDeniedCopyFeedback(page));
});
