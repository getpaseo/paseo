import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { revealSidebarProjectWorkspaces } from "../support/helpers/sidebar";
import {
  expectSidebarWorkspaceSelected,
  switchWorkspaceViaSidebar,
} from "../support/helpers/workspace-ui";

async function readVisibleWorkspaceOrder(page: Page): Promise<string[]> {
  const rows = page.getByRole("button", { name: /^Workspace \d{2}$/ });
  await expect(rows).toHaveCount(12);
  return rows.evaluateAll(
    (elements, prefix) =>
      elements.map((element) => element.getAttribute("data-testid")!.slice(prefix.length)),
    `sidebar-workspace-row-${getServerId()}:`,
  );
}

async function navigateWorkspace(
  page: Page,
  direction: "next" | "previous",
  workspaceId: string,
): Promise<void> {
  await page.keyboard.press(direction === "next" ? "Alt+]" : "Alt+[");
  await expectSidebarWorkspaceSelected({ page, serverId: getServerId(), workspaceId });
  await expect(page).toHaveURL(new RegExp(`/workspace/${workspaceId}$`));
}

test("previous and next traverse every visible workspace while digit shortcuts stop at nine", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const project = await seedWorkspace({
    repoPrefix: "relative-navigation-",
    title: "Workspace 01",
  });
  try {
    for (let index = 2; index <= 12; index += 1) {
      const created = await project.client.createWorkspace({
        source: { kind: "directory", path: project.repoPath },
        title: `Workspace ${String(index).padStart(2, "0")}`,
      });
      expect(created.error).toBeNull();
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await gotoAppShell(page);
    await revealSidebarProjectWorkspaces(page, project.projectKey);
    const order = await readVisibleWorkspaceOrder(page);

    await test.step("next crosses the ninth workspace and previous returns to it", async () => {
      await switchWorkspaceViaSidebar({ page, serverId: getServerId(), workspaceId: order[8] });
      await navigateWorkspace(page, "next", order[9]);
      await navigateWorkspace(page, "previous", order[8]);
    });

    await test.step("wrapping uses the true first and last visible workspace", async () => {
      await switchWorkspaceViaSidebar({ page, serverId: getServerId(), workspaceId: order[0] });
      await navigateWorkspace(page, "previous", order[11]);
      await navigateWorkspace(page, "next", order[0]);
    });

    await test.step("the ninth digit shortcut still selects the ninth workspace", async () => {
      await page.keyboard.press("Alt+9");
      await expectSidebarWorkspaceSelected({
        page,
        serverId: getServerId(),
        workspaceId: order[8],
      });
    });
    await test.step("hidden Done rows remain shortcut targets without expanding the project", async () => {
      await expectHiddenWorkspaceShortcuts(page, order);
    });
  } finally {
    await project.cleanup();
  }
});

async function expectHiddenWorkspaceShortcuts(page: Page, order: string[]) {
  await page.getByLabel("Show less", { exact: true }).click();
  const rows = page.getByRole("button", { name: /^Workspace \d{2}$/ });
  await expect(rows).toHaveCount(7);
  await switchWorkspaceViaSidebar({ page, serverId: getServerId(), workspaceId: order[0] });
  await page.keyboard.press("Alt+9");
  await expect(page).toHaveURL(new RegExp(`/workspace/${order[8]}$`));
  await expect(page.getByTestId(`sidebar-workspace-row-${getServerId()}:${order[8]}`)).toHaveCount(
    0,
  );
  await page.keyboard.press("Alt+]");
  await expect(page).toHaveURL(new RegExp(`/workspace/${order[9]}$`));
  await expect(rows).toHaveCount(7);
}
