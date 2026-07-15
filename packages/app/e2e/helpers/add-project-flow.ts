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

export async function waitForConnectedHost(
  page: Page,
  input: { serverId: string; endpoint: string },
): Promise<void> {
  await page.getByTestId("sidebar-hosts-trigger").click();
  const host = page.getByTestId(`sidebar-host-row-${input.serverId}`);
  await expect(host).toContainText(input.endpoint, { timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(host).not.toBeVisible();
}

export async function expectAddProjectPage(page: Page, kind: AddProjectFlowPage): Promise<Locator> {
  const currentPage = page.getByTestId(`add-project-flow-page-${kind}`);
  await expect(currentPage).toBeVisible({ timeout: 30_000 });
  return currentPage;
}

export async function openAddProjectFlow(
  page: Page,
  expectedPage: "host" | "method" = "method",
): Promise<void> {
  await page.getByTestId("sidebar-add-project").click();
  await expect(addProjectFlow(page)).toBeVisible({ timeout: 30_000 });
  await expectAddProjectPage(page, expectedPage);
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
