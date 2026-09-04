// Locks the VS Code preview-editor model for the Explorer: a single click reuses one tab, a
// double click keeps the file, and the Settings switch turns the reuse off.
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { openFileExplorer, expandFolder } from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

// packages/app/src/hooks/use-settings/keys.ts:3
const APP_SETTINGS_KEY = "@paseo:app-settings";

let workspace: SeededWorkspace;

test.beforeAll(async () => {
  workspace = await seedWorkspace({
    repoPrefix: "explorer-preview-tabs-",
    repo: {
      files: [
        { path: "src/alpha.ts", content: "export const alpha = true;\n" },
        { path: "src/bravo.ts", content: "export const bravo = true;\n" },
        { path: "src/charlie.ts", content: "export const charlie = true;\n" },
      ],
    },
  });
});

test.afterAll(async () => workspace?.cleanup());

function tabsRow(page: Page): Locator {
  return page.getByTestId("workspace-tabs-row").filter({ visible: true }).first();
}

/** Every file chip, preview or normal — the preview marker is a separate, additive test id. */
function fileTabChips(page: Page): Locator {
  return tabsRow(page).locator('[data-testid^="workspace-tab-file_"]');
}

function fileTabChip(page: Page, path: string): Locator {
  return tabsRow(page).getByTestId(`workspace-tab-file_${path}`);
}

function previewMarker(page: Page, path: string): Locator {
  return tabsRow(page).getByTestId(`workspace-tab-preview-file_${path}`);
}

/** Italics are the only visual difference between a preview chip and a normal one. */
async function tabLabelFontStyle(page: Page, path: string, label: string): Promise<string> {
  return fileTabChip(page, path)
    .getByText(label, { exact: true })
    .first()
    .evaluate((element) => getComputedStyle(element).fontStyle);
}

function explorerEntry(page: Page, name: string): Locator {
  return page
    .getByTestId("file-explorer-tree-scroll")
    .filter({ visible: true })
    .first()
    .getByText(name, { exact: true })
    .first();
}

/** A single click previews. Waits for the chip so callers assert intent, not tab plumbing. */
async function previewFile(page: Page, name: string): Promise<void> {
  await explorerEntry(page, name).click();
  await expect(fileTabChip(page, `src/${name}`)).toBeVisible({ timeout: 30_000 });
}

/** A double click keeps the file in a tab of its own. */
async function keepFile(page: Page, name: string): Promise<void> {
  await explorerEntry(page, name).dblclick();
  await expect(fileTabChip(page, `src/${name}`)).toBeVisible({ timeout: 30_000 });
}

/** The exact set of open file chips, so an unexpected extra tab fails too. */
async function expectOpenFiles(page: Page, names: readonly string[]): Promise<void> {
  await expect(fileTabChips(page)).toHaveCount(names.length);
  for (const name of names) {
    await expect(fileTabChip(page, `src/${name}`)).toBeVisible();
  }
}

async function openWorkspaceExplorer(page: Page): Promise<void> {
  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);
  await expandFolder(page, "src");
  await expect(explorerEntry(page, "alpha.ts")).toBeVisible({ timeout: 30_000 });
}

async function attachScreenshot(
  page: Page,
  testInfo: { attach: (name: string, options: { body: Buffer; contentType: string }) => unknown },
  name: string,
): Promise<void> {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}

test.describe("Explorer preview tabs", () => {
  test("single clicks reuse one preview tab", async ({ page }, testInfo) => {
    await openWorkspaceExplorer(page);

    await previewFile(page, "alpha.ts");
    await expectOpenFiles(page, ["alpha.ts"]);
    await attachScreenshot(page, testInfo, "preview-alpha");

    await previewFile(page, "bravo.ts");
    await attachScreenshot(page, testInfo, "preview-replaced-by-bravo");

    await expectOpenFiles(page, ["bravo.ts"]);
  });

  test("double clicks accumulate a tab per file", async ({ page }, testInfo) => {
    await openWorkspaceExplorer(page);

    await keepFile(page, "alpha.ts");
    await keepFile(page, "bravo.ts");
    await attachScreenshot(page, testInfo, "two-normal-tabs");

    await expectOpenFiles(page, ["alpha.ts", "bravo.ts"]);
  });

  test("a preview opens beside normal tabs without replacing them", async ({ page }, testInfo) => {
    await openWorkspaceExplorer(page);

    await keepFile(page, "alpha.ts");
    await keepFile(page, "bravo.ts");
    await attachScreenshot(page, testInfo, "before-preview");

    await previewFile(page, "charlie.ts");
    await attachScreenshot(page, testInfo, "after-preview");

    await expectOpenFiles(page, ["alpha.ts", "bravo.ts", "charlie.ts"]);
  });

  test("only the preview tab is marked", async ({ page }, testInfo) => {
    await openWorkspaceExplorer(page);

    await keepFile(page, "alpha.ts");
    await previewFile(page, "bravo.ts");
    await expectOpenFiles(page, ["alpha.ts", "bravo.ts"]);
    await attachScreenshot(page, testInfo, "normal-alpha-preview-bravo");

    // Read the normal and the preview chip in one go so a failure reports both sides at once.
    const chips = {
      normalMarkers: await previewMarker(page, "src/alpha.ts").count(),
      previewMarkers: await previewMarker(page, "src/bravo.ts").count(),
      normalFontStyle: await tabLabelFontStyle(page, "src/alpha.ts", "alpha.ts"),
      previewFontStyle: await tabLabelFontStyle(page, "src/bravo.ts", "bravo.ts"),
    };

    expect(chips).toEqual({
      normalMarkers: 0,
      previewMarkers: 1,
      normalFontStyle: "normal",
      previewFontStyle: "italic",
    });
  });

  test("every single click opens a normal tab when preview tabs are turned off", async ({
    page,
  }, testInfo) => {
    await page.addInitScript((settingsKey) => {
      localStorage.setItem(settingsKey, JSON.stringify({ previewTabsEnabled: false }));
    }, APP_SETTINGS_KEY);
    await openWorkspaceExplorer(page);

    await previewFile(page, "alpha.ts");
    await previewFile(page, "bravo.ts");
    await previewFile(page, "charlie.ts");
    await attachScreenshot(page, testInfo, "preview-tabs-disabled");

    await expectOpenFiles(page, ["alpha.ts", "bravo.ts", "charlie.ts"]);
    await expect(tabsRow(page).locator('[data-testid^="workspace-tab-preview-"]')).toHaveCount(0);
  });

  test("double-clicking a directory only folds it", async ({ page }, testInfo) => {
    await openWorkspaceExplorer(page);

    await explorerEntry(page, "src").click();
    await expect(explorerEntry(page, "alpha.ts")).toHaveCount(0);

    // Two toggles land back where they started, and no click on a folder ever opens a tab.
    await explorerEntry(page, "src").dblclick();
    await attachScreenshot(page, testInfo, "after-directory-double-click");
    await expect(explorerEntry(page, "alpha.ts")).toHaveCount(0);
    await expectOpenFiles(page, []);

    await explorerEntry(page, "src").click();
    await expect(explorerEntry(page, "alpha.ts")).toBeVisible({ timeout: 30_000 });
    await expectOpenFiles(page, []);
  });
});
