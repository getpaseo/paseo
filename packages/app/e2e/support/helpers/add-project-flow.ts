import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";

export type AddProjectTab = "existing" | "clone" | "new-folder";

export function addProjectFlow(page: Page): Locator {
  return page.getByTestId("add-project-flow");
}

/** The current tab's search or name field. */
export function addProjectFlowInput(page: Page): Locator {
  return page.getByTestId("add-project-flow-input");
}

export function addProjectFlowTab(page: Page, tab: AddProjectTab): Locator {
  return page.getByTestId(`add-project-flow-tab-${tab}`);
}

export function addProjectFlowSubmit(page: Page): Locator {
  return page.getByTestId("add-project-flow-submit");
}

export function addProjectFlowHostTrigger(page: Page): Locator {
  return page.getByTestId("add-project-flow-host-trigger");
}

export async function expectAddProjectTab(page: Page, tab: AddProjectTab): Promise<void> {
  await expect(addProjectFlowTab(page, tab)).toHaveAttribute("aria-selected", "true", {
    timeout: 30_000,
  });
}

/** Opens Add project from the sidebar; it starts on Existing with the search focused. */
export async function openAddProjectFlow(page: Page): Promise<void> {
  await page.locator('[data-testid="sidebar-add-project"]:visible').click();
  await expect(addProjectFlow(page)).toBeVisible({ timeout: 30_000 });
  await expectAddProjectTab(page, "existing");
  await expect(addProjectFlowInput(page)).toBeFocused();
}

export async function chooseAddProjectTab(page: Page, tab: AddProjectTab): Promise<void> {
  await addProjectFlowTab(page, tab).click();
  await expectAddProjectTab(page, tab);
}

export async function chooseAddProjectHost(page: Page, serverId: string): Promise<void> {
  await addProjectFlowHostTrigger(page).click();
  await page.getByTestId(`add-project-flow-host-${serverId}`).click();
}

/** Types a parent directory into the Location picker and uses it as typed. */
export async function chooseAddProjectLocation(page: Page, location: string): Promise<void> {
  await page.getByTestId("add-project-flow-location").click();
  await page.getByPlaceholder("Search folders or enter a path").last().fill(location);
  await page.getByText("Use this folder", { exact: true }).click();
  await expect(page.getByTestId("add-project-flow-location")).toContainText(
    path.basename(location),
  );
}

export async function expectNewWorkspaceForAddedProject(
  page: Page,
  input: {
    serverId: string;
    projectId: string;
    projectName: string;
    projectPath: string;
  },
): Promise<void> {
  await expect(page).toHaveURL(/\/new\?.*projectId=/u, { timeout: 30_000 });
  const url = new URL(page.url());
  expect(url.pathname).toBe("/new");
  expect(url.searchParams.get("serverId")).toBe(input.serverId);
  expect(url.searchParams.get("projectId")).toBe(input.projectId);
  expect(url.searchParams.get("dir")).toBe(input.projectPath);
  await expect(page.getByRole("button", { name: "Workspace project" })).toContainText(
    input.projectName,
    { timeout: 30_000 },
  );
}

export async function navigateAddProjectResults(
  page: Page,
  key: "ArrowDown" | "ArrowUp",
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) await page.keyboard.press(key);
}

export async function expectAddProjectResultVisible(page: Page, text: string): Promise<void> {
  const results = page.getByTestId("add-project-flow-results");
  const row = results.getByRole("button").filter({ has: page.getByText(text, { exact: true }) });
  await expect
    .poll(async () => {
      const viewport = await results.boundingBox();
      const bounds = await row.boundingBox();
      if (!viewport || !bounds) return false;
      return (
        bounds.y >= viewport.y - 1 && bounds.y + bounds.height <= viewport.y + viewport.height + 1
      );
    })
    .toBe(true);
}

/** Presses Enter on the focused Add host button, which the sheet's own Enter must not swallow. */
export async function chooseAddHostFromProjectFlow(page: Page): Promise<void> {
  await addProjectFlow(page).getByRole("button", { name: "Add host", exact: true }).focus();
  await page.keyboard.press("Enter");
}

export async function navigateAndDismissAddProject(page: Page): Promise<void> {
  // Keep both keys in one task so Escape closes with a selection update still queued.
  await page.evaluate(() => {
    for (const key of ["ArrowDown", "Escape"]) {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }),
      );
    }
  });
}

export function watchAddProjectRenderWarnings(page: Page): string[] {
  const warnings: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (text.includes("Cannot update a component") && text.includes("AddProjectFlow")) {
      warnings.push(text);
    }
  });
  return warnings;
}
