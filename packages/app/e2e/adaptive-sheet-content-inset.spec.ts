import { expect, test, type Page } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  readRails,
  readSheetHeaderRails,
  readVerticalGap,
  waitForSettledPosition,
} from "./helpers/sheet-layout";
import {
  openCompactSkillsIntegrations,
  openSkillSelection,
  openSkillsIntegrations,
  startSkillsSandbox,
  type SkillsSandbox,
} from "./helpers/skills-selection";

const COMPACT_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

const sandboxes: SkillsSandbox[] = [];

test.afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) {
    await sandbox.cleanup();
  }
});

async function openChooseSkillsOnPhone(page: Page): Promise<void> {
  sandboxes.push(await startSkillsSandbox(page));
  await gotoAppShell(page);
  await openCompactSkillsIntegrations(page);
  await openSkillSelection(page);
  await waitForSettledPosition(page.getByTestId("skill-selection-sheet"));
}

async function openChooseSkillsOnDesktop(page: Page): Promise<void> {
  sandboxes.push(await startSkillsSandbox(page));
  await gotoAppShell(page);
  await openSkillsIntegrations(page);
  await openSkillSelection(page);
}

function sheetHeaderRails(page: Page) {
  return readSheetHeaderRails(page, "skill-selection-sheet", "Choose skills");
}

function allSkillsCard(page: Page) {
  return page.getByTestId("skill-selection-all-card");
}

function skillListCard(page: Page) {
  return page.getByTestId("skill-selection-list-card");
}

function bundledSkillsLabel(page: Page) {
  return page.getByText("Bundled skills", { exact: true });
}

test.describe("Choose skills sheet on a compact form factor", () => {
  test.use({ viewport: COMPACT_VIEWPORT });

  test("keeps its cards on the sheet header rails", async ({ page }) => {
    await openChooseSkillsOnPhone(page);

    const header = await sheetHeaderRails(page);

    expect(await readRails(allSkillsCard(page))).toEqual(header);
    expect(await readRails(skillListCard(page))).toEqual(header);
  });

  test("gives the Bundled skills label more room above it than below", async ({ page }) => {
    await openChooseSkillsOnPhone(page);

    expect({
      aboveLabel: await readVerticalGap(allSkillsCard(page), bundledSkillsLabel(page)),
      belowLabel: await readVerticalGap(bundledSkillsLabel(page), skillListCard(page)),
    }).toEqual({ aboveLabel: 16, belowLabel: 12 });
  });
});

test.describe("Choose skills sheet on a desktop form factor", () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test("keeps its cards on the sheet header rails", async ({ page }) => {
    await openChooseSkillsOnDesktop(page);

    const header = await sheetHeaderRails(page);

    expect(await readRails(allSkillsCard(page))).toEqual(header);
    expect(await readRails(skillListCard(page))).toEqual(header);
  });

  test("gives the Bundled skills label more room above it than below", async ({ page }) => {
    await openChooseSkillsOnDesktop(page);

    expect({
      aboveLabel: await readVerticalGap(allSkillsCard(page), bundledSkillsLabel(page)),
      belowLabel: await readVerticalGap(bundledSkillsLabel(page), skillListCard(page)),
    }).toEqual({ aboveLabel: 16, belowLabel: 12 });
  });
});
