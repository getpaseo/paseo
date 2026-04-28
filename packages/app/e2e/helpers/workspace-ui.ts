import { expect, type Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { gotoHome } from "./app";

export async function openNewAgentComposer(page: Page): Promise<void> {
  await gotoHome(page);
}

export function workspaceLabelFromPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function candidateWorkspaceIds(inputPath: string): string[] {
  const trimmed = inputPath.replace(/\/+$/, "");
  const candidates = new Set<string>([trimmed]);
  if (trimmed.startsWith("/var/")) {
    candidates.add(`/private${trimmed}`);
  }
  if (trimmed.startsWith("/private/var/")) {
    candidates.add(trimmed.replace(/^\/private/, ""));
  }
  return Array.from(candidates);
}

function workspaceRowLocator(page: Page, serverId: string, workspacePath: string) {
  const ids = candidateWorkspaceIds(workspacePath).map(
    (id) => `[data-testid="sidebar-workspace-row-${serverId}:${id}"]`,
  );
  return page.locator(ids.join(",")).first();
}

export async function switchWorkspaceViaSidebar(input: {
  page: Page;
  serverId: string;
  targetWorkspacePath: string;
}): Promise<void> {
  const row = workspaceRowLocator(input.page, input.serverId, input.targetWorkspacePath);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  const targetWorkspaceRoute = buildHostWorkspaceRoute(input.serverId, input.targetWorkspacePath);
  await expect(input.page).toHaveURL(new RegExp(escapeRegex(targetWorkspaceRoute)), {
    timeout: 30_000,
  });
}

export async function expectWorkspaceHeader(
  page: Page,
  input: { title: string; subtitle: string },
): Promise<void> {
  const titleLocator = page.getByTestId("workspace-header-title");
  const subtitleLocator = page.getByTestId("workspace-header-subtitle");

  await expect(titleLocator.first()).toHaveText(input.title, {
    timeout: 30_000,
  });
  await expect(subtitleLocator.first()).toHaveText(input.subtitle, {
    timeout: 30_000,
  });
}

export async function seedWorkspaceActivity(page: Page, marker: string): Promise<void> {
  const input = page.getByRole("textbox", { name: "Message agent..." });
  await expect(input).toBeEditable({ timeout: 30_000 });
  await input.fill(marker);
  await input.press("Enter");
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
}
