import { expect, type Locator, type Page } from "@playwright/test";

export type AddProjectFlowPage =
  | "host"
  | "method"
  | "directory-search"
  | "github-search"
  | "github-location"
  | "new-directory-parent"
  | "new-directory-name";

export type AddProjectMethod = "directory-search" | "browse" | "github" | "new-directory";

const METHOD_DESTINATIONS: Record<Exclude<AddProjectMethod, "browse">, AddProjectFlowPage> = {
  "directory-search": "directory-search",
  github: "github-search",
  "new-directory": "new-directory-parent",
};

export function addProjectFlow(page: Page): Locator {
  return page.getByTestId("add-project-flow");
}

export function addProjectFlowInput(page: Page): Locator {
  return page.getByTestId("add-project-flow-input");
}

export function addProjectFlowBack(page: Page): Locator {
  return page.getByTestId("add-project-flow-back");
}

export function addProjectFlowHost(page: Page, serverId: string): Locator {
  return page.getByTestId(`add-project-flow-host-${serverId}`);
}

export function addProjectFlowMethod(page: Page, method: AddProjectMethod): Locator {
  return page.getByTestId(`add-project-flow-method-${method}`);
}

export async function expectAddProjectPage(page: Page, kind: AddProjectFlowPage): Promise<Locator> {
  const currentPage = page.getByTestId(`add-project-flow-page-${kind}`);
  await expect(currentPage).toBeVisible({ timeout: 30_000 });
  return currentPage;
}

async function openAddProjectFlowSurface(
  page: Page,
  expectedPage: "host" | "method",
): Promise<void> {
  await page.locator('[data-testid="sidebar-add-project"]:visible').click();
  await expect(addProjectFlow(page)).toBeVisible({ timeout: 30_000 });
  await expectAddProjectPage(page, expectedPage);
}

export async function openAddProjectFlow(page: Page): Promise<void> {
  await openAddProjectFlowSurface(page, "method");
}

export async function openAddProjectHostSelection(page: Page): Promise<void> {
  await openAddProjectFlowSurface(page, "host");
  await expect(addProjectFlowInput(page)).toBeFocused();
}

export async function chooseAddProjectMethod(page: Page, method: AddProjectMethod): Promise<void> {
  const option = addProjectFlowMethod(page, method);
  await expect(option).toBeVisible();
  await option.click();
  if (method !== "browse") {
    await expectAddProjectPage(page, METHOD_DESTINATIONS[method]);
  }
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
