import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { closeMobileAgentSidebar, openMobileAgentSidebar } from "../support/helpers/sidebar";

function workspaceRow(page: Page, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

async function openWorkspace(page: Page, workspaceId: string) {
  await workspaceRow(page, workspaceId).click();
  await expect(page).toHaveURL(new RegExp(`/workspace/${workspaceId}`));
}

async function chooseReadAction(page: Page, workspaceId: string, action: "read" | "unread") {
  await workspaceRow(page, workspaceId).hover();
  await page.getByTestId(`sidebar-workspace-kebab-${getServerId()}:${workspaceId}`).click();
  const item = page.getByRole("menuitem", { name: `Mark as ${action}`, exact: true });
  await expect(item).toBeVisible();
  await item.click();
}

async function expectStatus(page: Page, workspaceId: string, status: "done" | "attention") {
  await expect(
    workspaceRow(page, workspaceId).getByTestId(`workspace-status-indicator-${status}`),
  ).toBeVisible();
}

async function finishedWorkspace(title: string): Promise<MockAgentWorkspace> {
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "workspace-mark-unread-",
    title,
    initialPrompt: "Finish this turn.",
  });
  await workspace.client.waitForFinish(workspace.agentId, 20_000);
  await workspace.client.clearWorkspaceAttention(workspace.workspaceId);
  return workspace;
}

test("manual unread survives departure and clears on reopening without changing normal completions", async ({
  page,
}) => {
  const subject = await finishedWorkspace("Unread subject");
  const other = await finishedWorkspace("Other workspace");
  try {
    await gotoAppShell(page);
    await openWorkspace(page, other.workspaceId);
    await test.step("background workspace gains green dot and clears when clicked", async () => {
      await chooseReadAction(page, subject.workspaceId, "unread");
      await expectStatus(page, subject.workspaceId, "attention");
      await openWorkspace(page, subject.workspaceId);
      await expectStatus(page, subject.workspaceId, "done");
    });
    await test.step("focused workspace stays unread after departure and clears on reopening", async () => {
      await chooseReadAction(page, subject.workspaceId, "unread");
      await expectStatus(page, subject.workspaceId, "attention");
      await openWorkspace(page, other.workspaceId);
      await chooseReadAction(page, subject.workspaceId, "read");
      await expectStatus(page, subject.workspaceId, "done");
      await openWorkspace(page, subject.workspaceId);
      await chooseReadAction(page, subject.workspaceId, "unread");
      await openWorkspace(page, other.workspaceId);
      await expectStatus(page, subject.workspaceId, "attention");
      await openWorkspace(page, subject.workspaceId);
      await expectStatus(page, subject.workspaceId, "done");
    });
    await test.step("ordinary completion still clears on departure", async () => {
      await subject.client.sendAgentMessage(subject.agentId, "Finish another turn.");
      await subject.client.waitForFinish(subject.agentId, 20_000);
      await expectStatus(page, subject.workspaceId, "attention");
      await openWorkspace(page, other.workspaceId);
      await expectStatus(page, subject.workspaceId, "done");
    });
    await test.step("explicit Mark as read clears a background workspace", async () => {
      await chooseReadAction(page, subject.workspaceId, "unread");
      await expectStatus(page, subject.workspaceId, "attention");
      await chooseReadAction(page, subject.workspaceId, "read");
      await expectStatus(page, subject.workspaceId, "done");
    });
  } finally {
    await subject.cleanup();
    await other.cleanup();
  }
});

test("clicking a multi-agent workspace reveals and clears its marked agent", async ({ page }) => {
  const subject = await finishedWorkspace("First agent");
  const other = await finishedWorkspace("Other workspace");
  try {
    await openAgentRoute(page, subject);
    await expect(
      page.getByTestId(`workspace-tab-agent_${subject.agentId}`).first(),
    ).toHaveAttribute("aria-selected", "true");
    await openWorkspace(page, other.workspaceId);
    const newest = await subject.client.createAgent({
      provider: "mock",
      cwd: subject.cwd,
      workspaceId: subject.workspaceId,
      title: "Newest agent",
      modeId: "load-test",
      model: "e2e-fast-stream",
    });
    await chooseReadAction(page, subject.workspaceId, "unread");
    await expectStatus(page, subject.workspaceId, "attention");
    await openWorkspace(page, subject.workspaceId);
    await expectStatus(page, subject.workspaceId, "done");
    await expect(page.getByTestId(`workspace-tab-agent_${newest.id}`).first()).toHaveAttribute(
      "aria-selected",
      "true",
    );
  } finally {
    await subject.cleanup();
    await other.cleanup();
  }
});

test("manual unread survives leaving the current workspace on compact layout", async ({ page }) => {
  const subject = await finishedWorkspace("Compact unread");
  const other = await finishedWorkspace("Compact other");
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentRoute(page, subject);
    await openMobileAgentSidebar(page);
    await chooseReadAction(page, subject.workspaceId, "unread");
    await expectStatus(page, subject.workspaceId, "attention");
    await openWorkspace(page, other.workspaceId);
    await openMobileAgentSidebar(page);
    await chooseReadAction(page, subject.workspaceId, "read");
    await expectStatus(page, subject.workspaceId, "done");
    await openWorkspace(page, subject.workspaceId);
    await openMobileAgentSidebar(page);
    await chooseReadAction(page, subject.workspaceId, "unread");
    await openWorkspace(page, other.workspaceId);
    await openMobileAgentSidebar(page);
    await expectStatus(page, subject.workspaceId, "attention");
    await openWorkspace(page, subject.workspaceId);
    await openMobileAgentSidebar(page);
    await expectStatus(page, subject.workspaceId, "done");
    await chooseReadAction(page, subject.workspaceId, "unread");
    await closeMobileAgentSidebar(page);
    await page.getByRole("textbox", { name: "Message agent..." }).click();
    await openMobileAgentSidebar(page);
    await expectStatus(page, subject.workspaceId, "done");
    await closeMobileAgentSidebar(page);
    await subject.client.sendAgentMessage(subject.agentId, "Finish another turn.");
    await subject.client.waitForFinish(subject.agentId, 20_000);
    await openMobileAgentSidebar(page);
    await expectStatus(page, subject.workspaceId, "attention");
    await openWorkspace(page, other.workspaceId);
    await openMobileAgentSidebar(page);
    await expectStatus(page, subject.workspaceId, "done");
  } finally {
    await subject.cleanup();
    await other.cleanup();
  }
});
