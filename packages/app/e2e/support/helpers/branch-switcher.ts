import { expect, type Page } from "@playwright/test";
import { escapeRegex } from "./regex";
import { openChangesTreePanel } from "./workspace-tabs";

// The branch switcher lives in the Changes tab, not in the workspace header. It renders as a button whose
// accessible name carries the current branch ("Current branch: <name>. Press to
// switch branch."). Matching on the accessible name keeps these helpers tied to
// what a screen reader user hears, and it proves the panel resolved a real
// checkout directory from the opaque workspace id. Scoping to the repository
// header keeps the matcher aligned with the row that owns repository identity.
function branchSwitcherTrigger(page: Page, branchName: string) {
  return page
    .getByTestId("changes-repository-header")
    .getByRole("button", { name: new RegExp(`Current branch: ${escapeRegex(branchName)}\\b`) })
    .filter({ visible: true })
    .first();
}

// Opens the fixed Explorer Changes view, where the switcher lives.
export async function openChangesPanel(page: Page): Promise<void> {
  await openChangesTreePanel(page);
  await expect(
    page.getByTestId("changes-repository-header").filter({ visible: true }).first(),
  ).toBeVisible({ timeout: 30_000 });
}

export async function expectWorkspaceBranch(page: Page, branchName: string): Promise<void> {
  await expect(branchSwitcherTrigger(page, branchName)).toBeVisible({ timeout: 30_000 });
}

export async function switchBranchFromChangesPanel(
  page: Page,
  input: { from: string; to: string },
): Promise<void> {
  await branchSwitcherTrigger(page, input.from).click();

  const picker = page.getByTestId("combobox-desktop-container");
  await expect(picker).toBeVisible({ timeout: 30_000 });

  // The branch switcher combobox renders its options as plain text rows with no ARIA
  // role, so filter by the visible branch name and click the matching row. Filtering
  // first guarantees a single, unambiguous match.
  const search = page.getByPlaceholder("Filter branches...");
  await expect(search).toBeVisible({ timeout: 30_000 });
  await search.fill(input.to);

  const option = picker.getByText(input.to, { exact: true });
  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click();

  await expect(picker).not.toBeVisible({ timeout: 30_000 });
}

// The workspace header title is a plain static title in Model B; the branch
// switcher must never appear there. Asserting on the header testID keeps this
// honest even as the switcher continues to exist inside the Changes panel.
export async function expectNoBranchSwitcherInWorkspaceHeader(page: Page): Promise<void> {
  await expect(page.getByTestId("workspace-header-branch-switcher")).toHaveCount(0);
}
