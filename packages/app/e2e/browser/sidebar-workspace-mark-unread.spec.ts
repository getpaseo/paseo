import type { Page } from "@playwright/test";
import { test as base, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
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

function projectRow(page: Page, projectKey: string) {
  return page.getByTestId(`sidebar-project-row-${projectEquivalenceViewKey(projectKey)}`);
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

async function markAsUnread(page: Page, workspaceId: string) {
  await chooseReadAction(page, workspaceId, "unread");
  await expectStatus(page, workspaceId, "attention");
}

async function markAsRead(page: Page, workspaceId: string) {
  await chooseReadAction(page, workspaceId, "read");
  await expectStatus(page, workspaceId, "done");
}

async function expectStatus(page: Page, workspaceId: string, status: "done" | "attention") {
  await expect(
    workspaceRow(page, workspaceId).getByTestId(`workspace-status-indicator-${status}`),
  ).toBeVisible();
}

async function expectWorkspaceTitleWeight(
  page: Page,
  workspaceId: string,
  title: string,
  weight: "400" | "700",
) {
  // The title leads the row and the meta line below it can repeat the same text (a branch-named
  // workspace shows its name twice), so the first match is the title the weight belongs to.
  await expect(workspaceRow(page, workspaceId).getByText(title, { exact: true }).first()).toHaveCSS(
    "font-weight",
    weight,
  );
}

async function expectProjectTitleWeight(
  page: Page,
  projectKey: string,
  title: string,
  weight: "500" | "600" | "700",
) {
  await expect(projectRow(page, projectKey).getByText(title, { exact: true })).toHaveCSS(
    "font-weight",
    weight,
  );
}

async function markBackgroundWorkspaceAndReopen(
  page: Page,
  subject: MockAgentWorkspace,
  readProjectWeight: "500" | "600" = "600",
) {
  await test.step("background workspace gains green dot and clears when clicked", async () => {
    await expectWorkspaceTitleWeight(page, subject.workspaceId, subject.workspaceName, "400");
    await expectProjectTitleWeight(
      page,
      subject.projectKey,
      subject.projectDisplayName,
      readProjectWeight,
    );
    await markAsUnread(page, subject.workspaceId);
    await expectWorkspaceTitleWeight(page, subject.workspaceId, subject.workspaceName, "700");
    await expectProjectTitleWeight(page, subject.projectKey, subject.projectDisplayName, "700");
    await openWorkspace(page, subject.workspaceId);
    await expectStatus(page, subject.workspaceId, "done");
    await expectWorkspaceTitleWeight(page, subject.workspaceId, subject.workspaceName, "400");
    await expectProjectTitleWeight(
      page,
      subject.projectKey,
      subject.projectDisplayName,
      readProjectWeight,
    );
  });
}

async function leaveMarkedWorkspaceAndRead(page: Page, { subject, other }: FinishedWorkspaces) {
  await test.step("leaving preserves manual unread until Mark as read", async () => {
    await markAsUnread(page, subject.workspaceId);
    await openWorkspace(page, other.workspaceId);
    await markAsRead(page, subject.workspaceId);
    await openWorkspace(page, subject.workspaceId);
  });
}

async function leaveMarkedWorkspaceAndReopen(page: Page, { subject, other }: FinishedWorkspaces) {
  await test.step("leaving preserves manual unread until reopening", async () => {
    await markAsUnread(page, subject.workspaceId);
    await openWorkspace(page, other.workspaceId);
    await expectStatus(page, subject.workspaceId, "attention");
    await openWorkspace(page, subject.workspaceId);
    await expectStatus(page, subject.workspaceId, "done");
  });
}

async function completeTurnAndLeave(page: Page, { subject, other }: FinishedWorkspaces) {
  await test.step("ordinary completion clears while the agent tab is focused", async () => {
    await subject.client.sendAgentMessage(subject.agentId, "Finish another turn.");
    await subject.client.waitForFinish(subject.agentId, 20_000);
    await expectStatus(page, subject.workspaceId, "done");
    await openWorkspace(page, other.workspaceId);
    await expectStatus(page, subject.workspaceId, "done");
  });
}

async function openWorkspaceOnCompact(page: Page, workspaceId: string) {
  await openWorkspace(page, workspaceId);
  await openMobileAgentSidebar(page);
}

async function leaveMarkedWorkspaceAndReadOnCompact(
  page: Page,
  { subject, other }: FinishedWorkspaces,
) {
  await test.step("leaving preserves manual unread until Mark as read", async () => {
    await markAsUnread(page, subject.workspaceId);
    await openWorkspaceOnCompact(page, other.workspaceId);
    await markAsRead(page, subject.workspaceId);
    await openWorkspaceOnCompact(page, subject.workspaceId);
  });
}

async function leaveMarkedWorkspaceAndReopenOnCompact(
  page: Page,
  { subject, other }: FinishedWorkspaces,
) {
  await test.step("leaving preserves manual unread until reopening", async () => {
    await markAsUnread(page, subject.workspaceId);
    await openWorkspaceOnCompact(page, other.workspaceId);
    await expectStatus(page, subject.workspaceId, "attention");
    await openWorkspaceOnCompact(page, subject.workspaceId);
    await expectStatus(page, subject.workspaceId, "done");
  });
}

async function completeTurnAndLeaveOnCompact(page: Page, { subject, other }: FinishedWorkspaces) {
  await test.step("ordinary completion clears while the agent tab is focused", async () => {
    await closeMobileAgentSidebar(page);
    await subject.client.sendAgentMessage(subject.agentId, "Finish another turn.");
    await subject.client.waitForFinish(subject.agentId, 20_000);
    await openMobileAgentSidebar(page);
    await expectStatus(page, subject.workspaceId, "done");
    await openWorkspaceOnCompact(page, other.workspaceId);
    await expectStatus(page, subject.workspaceId, "done");
  });
}

async function markBackgroundWorkspaceAndRead(page: Page, workspaceId: string) {
  await test.step("explicit Mark as read clears a background workspace", async () => {
    await markAsUnread(page, workspaceId);
    await markAsRead(page, workspaceId);
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
    await markAsUnread(page, workspaceId);
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
  await markBackgroundWorkspaceAndReopen(page, workspaces.subject);
  await leaveMarkedWorkspaceAndRead(page, workspaces);
  await leaveMarkedWorkspaceAndReopen(page, workspaces);
  await completeTurnAndLeave(page, workspaces);
  await markBackgroundWorkspaceAndRead(page, workspaces.subject.workspaceId);
});

test("focused agent tab reads completions without focusing the composer", async ({
  page,
  workspaces,
}, testInfo) => {
  const { subject } = workspaces;
  await openAgentRoute(page, subject);
  await expectSelectedAgent(page, subject.agentId);
  await page.getByTestId(`workspace-tab-agent_${subject.agentId}`).first().click();
  await expect(page.getByRole("textbox", { name: "Message agent..." })).not.toBeFocused();
  await subject.client.sendAgentMessage(subject.agentId, "Finish while the tab has focus.");
  await subject.client.waitForFinish(subject.agentId, 20_000);
  await subject.client.waitForAgentUpsert(
    subject.agentId,
    (agent) => agent.requiresAttention === false,
    10_000,
  );
  await expectWorkspaceTitleWeight(page, subject.workspaceId, subject.workspaceName, "400");
  await expectProjectTitleWeight(page, subject.projectKey, subject.projectDisplayName, "600");
  await page.screenshot({ path: testInfo.outputPath("focused-agent-read.png") });
});

test("clicking a multi-agent workspace reveals and clears its marked agent", async ({
  page,
  workspaces,
}) => {
  await openAgentRoute(page, workspaces.subject);
  await expectSelectedAgent(page, workspaces.subject.agentId);
  await openWorkspace(page, workspaces.other.workspaceId);
  const newest = await addFinishedAgent(workspaces.subject);
  await markBackgroundWorkspaceAndReopen(page, workspaces.subject, "500");
  await expectSelectedAgent(page, newest.id);
});

test("manual unread survives leaving the current workspace on compact layout", async ({
  page,
  workspaces,
}) => {
  await openCompactWorkspace(page, workspaces.subject);
  await leaveMarkedWorkspaceAndReadOnCompact(page, workspaces);
  await leaveMarkedWorkspaceAndReopenOnCompact(page, workspaces);
  await markUnreadThenResumeChat(page, workspaces.subject.workspaceId);
  await completeTurnAndLeaveOnCompact(page, workspaces);
});
