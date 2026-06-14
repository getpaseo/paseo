import { expect, type Page } from "@playwright/test";
import { escapeRegex } from "./regex";

// The header branch switcher renders as a button whose accessible name carries the
// current branch ("Current branch: <name>. Press to switch branch."). Matching on the
// accessible name keeps these helpers tied to what a screen reader user hears, and it
// proves the header resolved a real checkout directory from the opaque workspace id.
function branchSwitcherTrigger(page: Page, branchName: string) {
  return page
    .getByRole("button", { name: new RegExp(`Current branch: ${escapeRegex(branchName)}\\b`) })
    .filter({ visible: true })
    .first();
}

export async function expectWorkspaceBranch(page: Page, branchName: string): Promise<void> {
  await expect(branchSwitcherTrigger(page, branchName)).toBeVisible({ timeout: 30_000 });
}

export async function switchBranchFromHeader(
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
