import type { Page } from "@playwright/test";
import { test as base, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { closeMobileAgentSidebar, openMobileAgentSidebar } from "../support/helpers/sidebar";

interface FinishedWorkspaces {
  subject: MockAgentWorkspace;
  other: MockAgentWorkspace;
}

const test = base.extend<{ workspaces: FinishedWorkspaces }>({
  workspaces: async ({ browserName: _browserName }, provide) => {
    const seeded: MockAgentWorkspace[] = [];
    async function finishedWorkspace(title: string) {
      const workspace = await seedMockAgentWorkspace({
        repoPrefix: "workspace-mark-unread-",
        title,
        initialPrompt: "Finish this turn.",
      });
      seeded.push(workspace);
      await workspace.client.waitForFinish(workspace.agentId, 20_000);
      await workspace.client.clearWorkspaceAttention(workspace.workspaceId);
      return workspace;
    }
    try {
      await provide({
        subject: await finishedWorkspace("Unread subject"),
        other: await finishedWorkspace("Other workspace"),
      });
    } finally {
      for (const workspace of seeded) await workspace.cleanup();
    }
  },
});

function workspaceRow(page: Page, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

async function openWorkspace(page: Page, workspaceId: string, compact = false) {
  await workspaceRow(page, workspaceId).click();
  await expect(page).toHaveURL(new RegExp(`/workspace/${workspaceId}`));
  if (compact) await openMobileAgentSidebar(page);
}

async function chooseReadAction(page: Page, workspaceId: string, action: "read" | "unread") {
  await workspaceRow(page, workspaceId).hover();
  await page.getByTestId(`sidebar-workspace-kebab-${getServerId()}:${workspaceId}`).click();
  const item = page.getByRole("menuitem", { name: `Mark as ${action}`, exact: true });
  await expect(item).toBeVisible();
  await item.click();
  await expectStatus(page, workspaceId, action === "unread" ? "attention" : "done");
}

async function expectStatus(page: Page, workspaceId: string, status: "done" | "attention") {
  await expect(
    workspaceRow(page, workspaceId).getByTestId(`workspace-status-indicator-${status}`),
  ).toBeVisible();
}

async function markBackgroundWorkspaceAndReopen(page: Page, workspaceId: string) {
  await test.step("background workspace gains green dot and clears when clicked", async () => {
    await chooseReadAction(page, workspaceId, "unread");
    await openWorkspace(page, workspaceId);
    await expectStatus(page, workspaceId, "done");
  });
}

async function leaveMarkedWorkspaceAndRead(
  page: Page,
  { subject, other }: FinishedWorkspaces,
  compact = false,
) {
  await test.step("leaving preserves manual unread until Mark as read", async () => {
    await chooseReadAction(page, subject.workspaceId, "unread");
    await openWorkspace(page, other.workspaceId, compact);
    await chooseReadAction(page, subject.workspaceId, "read");
    await openWorkspace(page, subject.workspaceId, compact);
  });
}

async function leaveMarkedWorkspaceAndReopen(
  page: Page,
  { subject, other }: FinishedWorkspaces,
  compact = false,
) {
  await test.step("leaving preserves manual unread until reopening", async () => {
    await chooseReadAction(page, subject.workspaceId, "unread");
    await openWorkspace(page, other.workspaceId, compact);
    await expectStatus(page, subject.workspaceId, "attention");
    await openWorkspace(page, subject.workspaceId, compact);
    await expectStatus(page, subject.workspaceId, "done");
  });
}

async function completeTurnAndLeave(
  page: Page,
  { subject, other }: FinishedWorkspaces,
  compact = false,
) {
  await test.step("ordinary completion still clears on departure", async () => {
    if (compact) await closeMobileAgentSidebar(page);
    await subject.client.sendAgentMessage(subject.agentId, "Finish another turn.");
    await subject.client.waitForFinish(subject.agentId, 20_000);
    if (compact) await openMobileAgentSidebar(page);
    await expectStatus(page, subject.workspaceId, "attention");
    await openWorkspace(page, other.workspaceId, compact);
    await expectStatus(page, subject.workspaceId, "done");
  });
}

async function markBackgroundWorkspaceAndRead(page: Page, workspaceId: string) {
  await test.step("explicit Mark as read clears a background workspace", async () => {
    await chooseReadAction(page, workspaceId, "unread");
    await chooseReadAction(page, workspaceId, "read");
  });
}

async function expectSelectedAgent(page: Page, agentId: string) {
  await expect(page.getByTestId(`workspace-tab-agent_${agentId}`).first()).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

async function addFinishedAgent(workspace: MockAgentWorkspace) {
  return workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.cwd,
    workspaceId: workspace.workspaceId,
    title: "Newest agent",
    modeId: "load-test",
    model: "e2e-fast-stream",
  });
}

async function openCompactWorkspace(page: Page, workspace: MockAgentWorkspace) {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAgentRoute(page, workspace);
  await openMobileAgentSidebar(page);
}

async function markUnreadThenResumeChat(page: Page, workspaceId: string) {
  await test.step("interacting with the visible chat clears manual unread", async () => {
    await chooseReadAction(page, workspaceId, "unread");
    await closeMobileAgentSidebar(page);
    await page.getByRole("textbox", { name: "Message agent..." }).click();
    await openMobileAgentSidebar(page);
    await expectStatus(page, workspaceId, "done");
  });
}

test("manual unread survives departure and clears on reopening without changing normal completions", async ({
  page,
  workspaces,
}) => {
  await gotoAppShell(page);
  await openWorkspace(page, workspaces.other.workspaceId);
  await markBackgroundWorkspaceAndReopen(page, workspaces.subject.workspaceId);
  await leaveMarkedWorkspaceAndRead(page, workspaces);
  await leaveMarkedWorkspaceAndReopen(page, workspaces);
  await completeTurnAndLeave(page, workspaces);
  await markBackgroundWorkspaceAndRead(page, workspaces.subject.workspaceId);
});

test("clicking a multi-agent workspace reveals and clears its marked agent", async ({
  page,
  workspaces,
}) => {
  await openAgentRoute(page, workspaces.subject);
  await expectSelectedAgent(page, workspaces.subject.agentId);
  await openWorkspace(page, workspaces.other.workspaceId);
  const newest = await addFinishedAgent(workspaces.subject);
  await markBackgroundWorkspaceAndReopen(page, workspaces.subject.workspaceId);
  await expectSelectedAgent(page, newest.id);
});

test("manual unread survives leaving the current workspace on compact layout", async ({
  page,
  workspaces,
}) => {
  await openCompactWorkspace(page, workspaces.subject);
  await leaveMarkedWorkspaceAndRead(page, workspaces, true);
  await leaveMarkedWorkspaceAndReopen(page, workspaces, true);
  await markUnreadThenResumeChat(page, workspaces.subject.workspaceId);
  await completeTurnAndLeave(page, workspaces, true);
});
