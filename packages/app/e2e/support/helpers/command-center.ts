import { expect, type Locator, type Page } from "@playwright/test";
import { expectFileTabOpen } from "./file-explorer";

export type CommandCenterTabName = "All" | "Workspaces" | "Files" | "Actions";

const TAB_PLACEHOLDERS: Record<CommandCenterTabName, string> = {
  All: "Search workspaces, files, and actions...",
  Workspaces: "Search workspaces...",
  Files: "Search files...",
  Actions: "Search actions...",
};

/** Outside a workspace there are no files to search, so All does not offer them. */
const TAB_PLACEHOLDERS_WITHOUT_WORKSPACE: Record<CommandCenterTabName, string> = {
  ...TAB_PLACEHOLDERS,
  All: "Search workspaces and actions...",
};

// Opens the command center / global search palette from the sidebar and returns its panel.
export async function openCommandCenter(page: Page): Promise<Locator> {
  await page.getByTestId("sidebar-search").click();
  const panel = page.getByTestId("command-center-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

/** Opens the file search (Files scope) from the keyboard shortcut. */
export async function openFileSearch(page: Page): Promise<Locator> {
  await page.keyboard.press("Meta+P");
  const panel = page.getByTestId("command-center-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByTestId("command-center-files-scope")).toBeVisible();
  return panel;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Types a path into the file search, opens the row it offers, and waits for the file tab.
 *
 * `typedPath` is what the user pastes; `expectedPath` is the path the tab should carry — they
 * differ when the typed path reaches the file through parent segments.
 */
export async function openFileByTypedPath(
  page: Page,
  input: { typedPath: string; expectedPath: string; fileName: string },
): Promise<void> {
  const panel = await openFileSearch(page);
  await panel.getByTestId("command-center-input").fill(input.typedPath);

  const row = panel
    .getByRole("button", { name: new RegExp(escapeForRegExp(input.fileName)) })
    .first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  await expectFileTabOpen(page, input.expectedPath);
}

export async function closeCommandCenter(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-center-panel")).not.toBeVisible();
}

function commandCenterTab(panel: Locator, name: CommandCenterTabName): Locator {
  return panel.getByTestId("command-center-tabs").getByRole("button", { name, exact: true });
}

export async function selectCommandCenterTab(
  panel: Locator,
  name: CommandCenterTabName,
  options: { workspaceOpen?: boolean } = {},
): Promise<void> {
  await commandCenterTab(panel, name).click();
  await expectCommandCenterTab(panel, name, options);
}

/**
 * The tab is selected and the search field asks for what that tab lists. Pass
 * `{ workspaceOpen: false }` when the command center was opened outside a workspace.
 */
export async function expectCommandCenterTab(
  panel: Locator,
  name: CommandCenterTabName,
  options: { workspaceOpen?: boolean } = {},
): Promise<void> {
  const placeholders =
    options.workspaceOpen === false ? TAB_PLACEHOLDERS_WITHOUT_WORKSPACE : TAB_PLACEHOLDERS;
  await expect(commandCenterTab(panel, name)).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByTestId("command-center-input")).toHaveAttribute(
    "placeholder",
    placeholders[name],
  );
}

/** Exactly these tabs are offered, in this order. */
export async function expectCommandCenterTabs(
  panel: Locator,
  names: readonly CommandCenterTabName[],
): Promise<void> {
  await expect(panel.getByTestId("command-center-tabs").getByRole("button")).toHaveText([...names]);
}

export function commandCenterSection(panel: Locator, title: string): Locator {
  return panel.getByTestId("command-center-results").getByText(title, { exact: true });
}
