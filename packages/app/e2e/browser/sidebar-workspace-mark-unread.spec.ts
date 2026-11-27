import type { Page } from "@playwright/test";
import { test as base, expect } from "../support/fixtures";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";
import {
  expectNoSheetOpen,
  expectOneSheetOpen,
  expectOpenTabCount,
  tapSheetBackdrop,
} from "../support/helpers/sheet";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  composerLocator,
  expectComposerDraft,
  expectComposerFocused,
} from "../support/helpers/composer";
import { expectReconnectingToastGone } from "../support/helpers/workspace-ui";
import { getServerId } from "../support/helpers/server-id";
import {
  closeMobileAgentSidebar,
  openMobileAgentSidebar,
  selectSidebarStatusGrouping,
} from "../support/helpers/sidebar";

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

async function openWorkspace(page: Page, workspaceId: string) {
  await workspaceRow(page, workspaceId).click();
  await expect(page).toHaveURL(new RegExp(`/workspace/${workspaceId}`));
}

async function chooseWorkspaceMarkAsRead(page: Page, workspaceId: string) {
  await workspaceRow(page, workspaceId).hover();
  await page.getByTestId(`sidebar-workspace-kebab-${getServerId()}:${workspaceId}`).click();
  const item = page.getByRole("menuitem", { name: "Mark all as read", exact: true });
  await expect(item).toBeVisible();
  await item.click();
}

async function chooseChatReviewAction(
  page: Page,
  workspaceId: string,
  agentId: string,
  action: "mark-as-read" | "mark-as-unread" | "mark-done" | "mark-for-follow-up",
  compact = false,
) {
  const tabId = `agent_${agentId}`;
  if (compact) {
    await page
      .getByTestId(`workspace-deck-entry-${getServerId()}:${workspaceId}`)
      .getByTestId("workspace-tab-switcher-trigger")
      .click();
    await page.getByTestId(`workspace-tab-menu-${tabId}-trigger`).click();
    await page.getByTestId(`workspace-tab-menu-${tabId}-${action}`).click();
    await expectOneSheetOpen(page);
    await tapSheetBackdrop(page);
    await expectNoSheetOpen(page);
    return;
  }
  await page
    .getByTestId(`workspace-tab-${tabId}`)
    .filter({ visible: true })
    .click({ button: "right" });
  await page
    .getByTestId(`workspace-tab-context-${tabId}-${action}`)
    .filter({ visible: true })
    .click();
}

async function markAsUnread(page: Page, workspace: MockAgentWorkspace, compact = false) {
  if (compact) await closeMobileAgentSidebar(page);
  await chooseChatReviewAction(
    page,
    workspace.workspaceId,
    workspace.agentId,
    "mark-as-unread",
    compact,
  );
  if (compact) await openMobileAgentSidebar(page);
  await expectStatus(page, workspace.workspaceId, "attention");
}

async function markAsRead(page: Page, workspaceId: string) {
  await chooseWorkspaceMarkAsRead(page, workspaceId);
  await expectStatus(page, workspaceId, "needs_follow_up");
}

async function expectStatus(
  page: Page,
  workspaceId: string,
  status: "done" | "attention" | "needs_follow_up" | "needs_input",
) {
  await expect(
    workspaceRow(page, workspaceId).getByTestId(`workspace-status-indicator-${status}`),
  ).toBeVisible();
}

async function markBackgroundWorkspaceAndReopen(page: Page, workspace: MockAgentWorkspace) {
  await test.step("a chat marked unread in the background clears on reopening", async () => {
    await workspace.client.markAgentUnread(workspace.agentId);
    await expectStatus(page, workspace.workspaceId, "attention");
    await openWorkspace(page, workspace.workspaceId);
    await expectStatus(page, workspace.workspaceId, "needs_follow_up");
  });
}

async function leaveMarkedWorkspaceAndRead(page: Page, { subject, other }: FinishedWorkspaces) {
  await test.step("leaving preserves manual unread until Mark all as read", async () => {
    await markAsUnread(page, subject);
    await openWorkspace(page, other.workspaceId);
    await markAsRead(page, subject.workspaceId);
    await openWorkspace(page, subject.workspaceId);
  });
}

async function leaveMarkedWorkspaceAndReopen(page: Page, { subject, other }: FinishedWorkspaces) {
  await test.step("leaving preserves manual unread until reopening", async () => {
    await markAsUnread(page, subject);
    await openWorkspace(page, other.workspaceId);
    await expectStatus(page, subject.workspaceId, "attention");
    await openWorkspace(page, subject.workspaceId);
    await expectStatus(page, subject.workspaceId, "needs_follow_up");
  });
}

async function completeTurnAndLeave(page: Page, { subject, other }: FinishedWorkspaces) {
  await test.step("ordinary completion stays unread on departure and clears on return", async () => {
    await subject.client.sendAgentMessage(subject.agentId, "Finish another turn.");
    await subject.client.waitForFinish(subject.agentId, 20_000);
    await expectStatus(page, subject.workspaceId, "attention");
    await openWorkspace(page, other.workspaceId);
    await expectStatus(page, subject.workspaceId, "attention");
    await openWorkspace(page, subject.workspaceId);
    await expectStatus(page, subject.workspaceId, "needs_follow_up");
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
  await test.step("leaving preserves manual unread until Mark all as read", async () => {
    await markAsUnread(page, subject, true);
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
    await markAsUnread(page, subject, true);
    await openWorkspaceOnCompact(page, other.workspaceId);
    await expectStatus(page, subject.workspaceId, "attention");
    await openWorkspaceOnCompact(page, subject.workspaceId);
    await expectStatus(page, subject.workspaceId, "needs_follow_up");
  });
}

async function completeTurnAndLeaveOnCompact(page: Page, { subject, other }: FinishedWorkspaces) {
  await test.step("ordinary completion stays unread on departure and clears on return", async () => {
    await closeMobileAgentSidebar(page);
    await subject.client.sendAgentMessage(subject.agentId, "Finish another turn.");
    await subject.client.waitForFinish(subject.agentId, 20_000);
    await openMobileAgentSidebar(page);
    await expectStatus(page, subject.workspaceId, "attention");
    await openWorkspaceOnCompact(page, other.workspaceId);
    await expectStatus(page, subject.workspaceId, "attention");
    await openWorkspaceOnCompact(page, subject.workspaceId);
    await expectStatus(page, subject.workspaceId, "needs_follow_up");
  });
}

async function markBackgroundWorkspaceAndRead(page: Page, workspace: MockAgentWorkspace) {
  await test.step("Mark all as read clears a background workspace", async () => {
    await workspace.client.markAgentUnread(workspace.agentId);
    await expectStatus(page, workspace.workspaceId, "attention");
    await markAsRead(page, workspace.workspaceId);
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
  await expect(page.getByText("Finish this turn.", { exact: true })).toBeVisible();
  await openMobileAgentSidebar(page);
}

async function markUnreadThenResumeChat(page: Page, workspace: MockAgentWorkspace) {
  await test.step("interacting with the visible chat clears manual unread", async () => {
    await markAsUnread(page, workspace, true);
    await closeMobileAgentSidebar(page);
    await page.getByRole("textbox", { name: "Message agent..." }).click();
    await openMobileAgentSidebar(page);
    await expectStatus(page, workspace.workspaceId, "needs_follow_up");
  });
}

test("manual unread survives departure and clears on reopening and ordinary completion survives departure", async ({
  page,
  workspaces,
}) => {
  await openAgentRoute(page, workspaces.subject);
  await expect(page.getByText("Finish this turn.", { exact: true })).toBeVisible();
  await openWorkspace(page, workspaces.other.workspaceId);
  await markBackgroundWorkspaceAndReopen(page, workspaces.subject);
  await leaveMarkedWorkspaceAndRead(page, workspaces);
  await leaveMarkedWorkspaceAndReopen(page, workspaces);
  await completeTurnAndLeave(page, workspaces);
  await openWorkspace(page, workspaces.other.workspaceId);
  await markBackgroundWorkspaceAndRead(page, workspaces.subject);
});

test("clicking a multi-agent workspace preserves its selected agent and leaves the other unread", async ({
  page,
  workspaces,
}) => {
  await openAgentRoute(page, workspaces.subject);
  await expect(page.getByText("Finish this turn.", { exact: true })).toBeVisible();
  await expectSelectedAgent(page, workspaces.subject.agentId);
  await openWorkspace(page, workspaces.other.workspaceId);
  const second = await addFinishedAgent(workspaces.subject);
  await workspaces.subject.client.markAgentUnread(second.id);
  await openWorkspace(page, workspaces.subject.workspaceId);
  await expectSelectedAgent(page, workspaces.subject.agentId);
  await expectStatus(page, workspaces.subject.workspaceId, "attention");
});

test("manual unread survives leaving the current workspace on compact layout", async ({
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  await openCompactWorkspace(page, workspaces.subject);
  await leaveMarkedWorkspaceAndReadOnCompact(page, workspaces);
  await leaveMarkedWorkspaceAndReopenOnCompact(page, workspaces);
  await markUnreadThenResumeChat(page, workspaces.subject);
  await completeTurnAndLeaveOnCompact(page, workspaces);
});

async function reopenWorkspaceAfterBackgroundTurn(page: Page, workspace: MockAgentWorkspace) {
  const route = page.url();
  // End this app session before the turn, so its cached transcript cannot contain the new prompt.
  await page.goto("about:blank");
  await workspace.client.sendAgentMessage(
    workspace.agentId,
    "A turn completed while the app was closed.",
  );
  await workspace.client.waitForFinish(workspace.agentId, 20_000);
  // Reopen the ordinary workspace route, without an agent open intent that would repair focus.
  await page.goto(route);
  await expect(page.getByRole("button", { name: /Switch tabs/ })).toBeVisible();
}

async function expectRestoredCompactChat(page: Page) {
  await expectOpenTabCount(page, 1);
  await expect(
    page.getByText("A turn completed while the app was closed.", { exact: true }),
  ).toBeVisible();
}

test("reopening a marked unread workspace restores only its agent tab and current history on compact layout", async ({
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  await test.step("open a finished chat with one main tab", async () => {
    await openCompactWorkspace(page, workspaces.subject);
    await closeMobileAgentSidebar(page);
    await expectOpenTabCount(page, 1);
    await expect(page.getByText("Finish this turn.", { exact: true })).toBeVisible();
  });
  await test.step("mark the current chat unread, then close and reopen the app", async () => {
    await openMobileAgentSidebar(page);
    await markAsUnread(page, workspaces.subject, true);
    await reopenWorkspaceAfterBackgroundTurn(page, workspaces.subject);
  });
  await test.step("restore the main tab without Explorer entries and load its latest history", async () => {
    await expectRestoredCompactChat(page);
  });
});

test("clicking the already focused timeline acknowledges a new completion", async ({
  page,
  workspaces,
}) => {
  await openAgentRoute(page, workspaces.subject);
  await expect(page.getByText("Finish this turn.", { exact: true })).toBeVisible();
  await workspaces.subject.client.sendAgentMessage(
    workspaces.subject.agentId,
    "Finish another turn.",
  );
  await workspaces.subject.client.waitForFinish(workspaces.subject.agentId, 20_000);
  await expectStatus(page, workspaces.subject.workspaceId, "attention");
  await page.getByText("Finish another turn.", { exact: true }).click();
  await expectStatus(page, workspaces.subject.workspaceId, "needs_follow_up");
});

test("each chat tab keeps its own follow-up dot when switching or marking done", async ({
  page,
  workspaces: { subject },
}, testInfo) => {
  const gate = await installDaemonWebSocketGate(page);
  await openAgentRoute(page, subject);
  const tab = (id: string) =>
    page.getByTestId(`workspace-tab-agent_${id}`).filter({ visible: true });
  const firstDot = tab(subject.agentId).getByTestId("agent-status-dot");
  const workspaceDot = workspaceRow(page, subject.workspaceId)
    .getByTestId("workspace-status-indicator-needs_follow_up")
    .locator(":scope > *");
  await expect(workspaceDot).toBeVisible();
  const purple = await workspaceDot.evaluate((dot) => getComputedStyle(dot).backgroundColor);
  await expect(firstDot).toHaveCSS("background-color", purple);

  const second = await addFinishedAgent(subject);
  await openAgentRoute(page, { workspaceId: subject.workspaceId, agentId: second.id });
  await expectSelectedAgent(page, second.id);
  const secondDot = tab(second.id).getByTestId("agent-status-dot");
  await expect(firstDot).toHaveCSS("background-color", purple);
  await expect(secondDot).toHaveCount(0);

  await subject.client.sendAgentMessage(second.id, "Finish the second chat");
  await subject.client.waitForFinish(second.id, 20_000);
  await expectStatus(page, subject.workspaceId, "attention");
  await expect(secondDot).toBeVisible();
  await expect(secondDot).not.toHaveCSS("background-color", purple);
  await expect(firstDot).toHaveCSS("background-color", purple);
  const reviewPill = page
    .getByTestId("composer-track-scroll")
    .filter({ visible: true })
    .getByTestId("composer-mark-done");
  await expect(reviewPill).toHaveAccessibleName("Ready to review · Mark done");
  await reviewPill.screenshot({ path: testInfo.outputPath("ready.png") });
  await page.getByText("Finish the second chat", { exact: true }).click();
  await expect(secondDot).toHaveCSS("background-color", purple);
  await expect(reviewPill).toHaveAccessibleName("Needs follow-up · Mark done");
  const restingFill = await reviewPill.evaluate((el) => getComputedStyle(el).backgroundColor);
  const restingBounds = await reviewPill.boundingBox();
  await reviewPill.screenshot({ path: testInfo.outputPath("rest.png") });
  await reviewPill.hover();
  await expect(reviewPill).not.toHaveCSS("background-color", restingFill);
  expect(await reviewPill.boundingBox()).toEqual(restingBounds);
  await reviewPill.screenshot({ path: testInfo.outputPath("hover.png") });
  await page.mouse.move(0, 0);
  await expect(reviewPill).toHaveCSS("background-color", restingFill);
  const ack = "agent.mark_done.response";
  gate.holdNextServerMessage(ack);
  await reviewPill.click();
  await gate.waitForHeldServerMessage(ack);
  await expect(secondDot).toHaveCount(0);
  await expect(reviewPill).toHaveAccessibleName("Needs follow-up · Saving...");
  await expect(reviewPill).toHaveText("Needs follow-up · Saving...");
  await expect(reviewPill).toHaveCSS("background-color", restingFill);
  await expect(reviewPill).toHaveCSS("opacity", "1");
  await reviewPill.screenshot({ path: testInfo.outputPath("saving.png") });
  await expect(firstDot).toHaveCSS("background-color", purple);
  await expectStatus(page, subject.workspaceId, "needs_follow_up");
  await subject.client.sendAgentMessage(second.id, "A newer result");
  await subject.client.waitForFinish(second.id, 20_000);
  await expect(reviewPill).toHaveAccessibleName("Ready to review · Mark done");
  gate.releaseHeldServerMessage(ack);
  await expect(reviewPill).toBeEnabled();
  await expect(reviewPill).toHaveAccessibleName("Ready to review · Mark done");
  gate.holdNextServerMessage(ack);
  await reviewPill.click();
  await gate.waitForHeldServerMessage(ack);
  await expect(reviewPill).toHaveAccessibleName("Ready to review · Saving...");
  gate.releaseHeldServerMessage(ack);
  await expect(reviewPill).toHaveText("Done");
});

test("compact review pill preserves the draft and retries an interrupted save", async ({
  page,
  workspaces: { subject },
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const gate = await installDaemonWebSocketGate(page);
  await openAgentRoute(page, subject);
  const pill = page.getByTestId("composer-track-scroll").getByTestId("composer-mark-done");
  await expect(pill).toHaveAccessibleName("Needs follow-up · Mark done");
  const bounds = await pill.boundingBox();
  if (!bounds) throw new Error("The review action must have a touch target");
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(375);
  await page.screenshot({ path: testInfo.outputPath("review-pill-compact.png") });
  await composerLocator(page).fill("Keep my follow-up draft");

  const request = "agent.mark_done.request";
  gate.holdNextClientRequest(request);
  await pill.click();
  await gate.waitForHeldClientRequest();
  await expect(pill).toBeDisabled();
  await expect(pill).toHaveText("Needs follow-up · Saving...");
  await page.screenshot({ path: testInfo.outputPath("review-pill-compact-saving.png") });
  await expectComposerFocused(page);
  await gate.drop();
  await expect(
    page.getByRole("alert").filter({ hasText: "Dropped by reconnect test" }),
  ).toBeVisible();
  await gate.waitForBlockedConnection();
  gate.restore();
  await expect(pill).toBeEnabled({ timeout: 30000 });
  await expect(pill).toContainText("Mark done");
  await expectComposerDraft(page, "Keep my follow-up draft");

  gate.holdNextClientRequest(request);
  await pill.click();
  await gate.waitForHeldClientRequest();
  expect(gate.getClientRequestCount(request)).toBe(2);
  gate.releaseHeldClientRequest();
  await expect(pill).toHaveText("Done");
  await expect(pill).toHaveCount(0);
  await expectComposerDraft(page, "Keep my follow-up draft");
});

async function reconnectWithoutInteracting(
  page: Page,
  gate: Awaited<ReturnType<typeof installDaemonWebSocketGate>>,
) {
  await gate.drop();
  await gate.waitForBlockedConnection();
  gate.restore();
  await expectReconnectingToastGone(page);
  await expect(page.getByRole("alert").filter({ hasText: "Updating messages" })).toHaveCount(0);
}

test("reconnecting a focused chat preserves its unread completion until another click", async ({
  page,
  workspaces,
}) => {
  const gate = await installDaemonWebSocketGate(page);
  await openAgentRoute(page, workspaces.subject);
  await expect(page.getByText("Finish this turn.", { exact: true })).toBeVisible();
  await workspaces.subject.client.sendAgentMessage(
    workspaces.subject.agentId,
    "Unread across reconnect.",
  );
  await workspaces.subject.client.waitForFinish(workspaces.subject.agentId, 20_000);
  await expectStatus(page, workspaces.subject.workspaceId, "attention");
  await reconnectWithoutInteracting(page, gate);
  await expectStatus(page, workspaces.subject.workspaceId, "attention");
  await page.getByText("Unread across reconnect.", { exact: true }).click();
  await expectStatus(page, workspaces.subject.workspaceId, "needs_follow_up");
});

test("a cached read chat acknowledges a completion that arrived while the app was closed", async ({
  page,
  workspaces,
}) => {
  await openCompactWorkspace(page, workspaces.subject);
  await expectStatus(page, workspaces.subject.workspaceId, "needs_follow_up");
  await closeMobileAgentSidebar(page);
  await reopenWorkspaceAfterBackgroundTurn(page, workspaces.subject);
  await expectRestoredCompactChat(page);
  await openMobileAgentSidebar(page);
  await expectStatus(page, workspaces.subject.workspaceId, "needs_follow_up");
});

test("workspace unread stays available on a legacy daemon", async ({ page, workspaces }) => {
  const { subject } = workspaces;
  // Keep review data from the modern daemon so this test exercises the app's capability gate.
  const gate = await installDaemonWebSocketGate(page, { stripFeatures: ["agentFollowUp"] });
  await openAgentRoute(page, subject);
  await expectSelectedAgent(page, subject.agentId);
  await expectStatus(page, subject.workspaceId, "needs_follow_up");

  const tabId = `agent_${subject.agentId}`;
  const tab = page.getByTestId(`workspace-tab-${tabId}`).filter({ visible: true });
  await expect(tab.getByTestId("agent-status-dot")).toBeVisible();
  await expect(page.getByTestId("composer-mark-done")).toHaveCount(0);

  const tabMenu = `workspace-tab-context-${tabId}`;
  await tab.click({ button: "right" });
  await expect(
    page.getByTestId(`${tabMenu}-copy-agent-id`).filter({ visible: true }),
  ).toBeVisible();
  await expect(page.getByTestId(`${tabMenu}-mark-done`)).toHaveCount(0);
  await expect(page.getByTestId(`${tabMenu}-mark-as-unread`)).toHaveCount(0);
  await page.keyboard.press("Escape");

  await workspaceRow(page, subject.workspaceId).hover();
  await page.getByTestId(`sidebar-workspace-kebab-${getServerId()}:${subject.workspaceId}`).click();
  await expect(page.getByRole("menuitem", { name: "Mark all as done", exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("menuitem", { name: "Mark as unread", exact: true }).click();
  await expectStatus(page, subject.workspaceId, "attention");
  expect(gate.getClientRequestCount("workspace.mark_unread.request")).toBe(1);
  expect(gate.getClientRequestCount("agent.review.mark_unread.request")).toBe(0);

  await chooseWorkspaceMarkAsRead(page, subject.workspaceId);
  await expectStatus(page, subject.workspaceId, "needs_follow_up");
  const requests = gate.getClientRequests("workspace.clear_attention.request");
  expect(requests).toHaveLength(1);
  expect(requests[0]).not.toHaveProperty("observedAttentionKeys");
});

test("Mark all as done resolves the selected workspace's current results", async ({
  page,
  workspaces: { subject, other },
}) => {
  const gate = await installDaemonWebSocketGate(page);
  const second = await addFinishedAgent(subject);
  await subject.client.sendAgentMessage(second.id, "A result that has not been read");
  await subject.client.waitForFinish(second.id, 20_000);
  await openAgentRoute(page, subject);
  await expectStatus(page, subject.workspaceId, "attention");
  await expectStatus(page, other.workspaceId, "needs_follow_up");

  const item = page.getByTestId(
    `sidebar-workspace-menu-mark-all-done-${getServerId()}:${subject.workspaceId}`,
  );
  const openMenu = async () => {
    await workspaceRow(page, subject.workspaceId).hover();
    await page
      .getByTestId(`sidebar-workspace-kebab-${getServerId()}:${subject.workspaceId}`)
      .click();
  };
  await openMenu();
  await expect(item).toHaveText("Mark all as done");
  const ack = "agent.mark_done.response";
  gate.holdNextServerMessage(ack);
  await item.click();
  await gate.waitForHeldServerMessage(ack);
  await expect(item).toHaveText("Saving...");
  await expect(item).toBeDisabled();
  gate.releaseHeldServerMessage(ack);
  await expectStatus(page, subject.workspaceId, "done");
  await expectStatus(page, other.workspaceId, "needs_follow_up");
  await expect(item).toHaveCount(0);
  await page.keyboard.press("Escape");

  await chooseChatReviewAction(page, subject.workspaceId, subject.agentId, "mark-for-follow-up");
  await expectStatus(page, subject.workspaceId, "needs_follow_up");
  await openMenu();
  gate.holdNextClientRequest("agent.mark_done.request");
  await item.click();
  await gate.waitForHeldClientRequest();

  await subject.client.sendAgentMessage(subject.agentId, "A newer result to review");
  await subject.client.waitForFinish(subject.agentId, 20_000);
  await expectStatus(page, subject.workspaceId, "attention");
  gate.releaseHeldClientRequest();
  await expect(page.getByTestId("app-toast-message")).toHaveText(
    "This chat result is no longer current",
  );
  await expect(item).toBeEnabled();
  await item.click();
  await expectStatus(page, subject.workspaceId, "done");
  await expectStatus(page, other.workspaceId, "needs_follow_up");
  await expect(page.getByText("This chat result is no longer current")).toHaveCount(0);
});

test("Mark all as read acknowledges a result while a sibling needs input", async ({
  page,
  workspaces,
}) => {
  const { subject, other } = workspaces;
  const sibling = await addFinishedAgent(subject);
  await subject.client.sendAgentMessage(sibling.id, "Emit synthetic plan approval.");
  expect((await subject.client.waitForFinish(sibling.id, 15_000)).status).toBe("permission");

  await openAgentRoute(page, other);
  await expectStatus(page, subject.workspaceId, "needs_input");
  await subject.client.markAgentUnread(subject.agentId);
  await chooseWorkspaceMarkAsRead(page, subject.workspaceId);

  await expectStatus(page, subject.workspaceId, "needs_input");
  await workspaceRow(page, subject.workspaceId).hover();
  await page.getByTestId(`sidebar-workspace-kebab-${getServerId()}:${subject.workspaceId}`).click();
  await expect(page.getByTestId("workspace-menu-chat-status")).toHaveText(
    "1 Needs input · 1 Needs follow-up",
  );
  await expect(page.getByRole("menuitem", { name: "Mark all as read", exact: true })).toHaveCount(
    0,
  );
});

test("review actions affect only the chat chosen in the tab menu", async ({ page, workspaces }) => {
  const { subject } = workspaces;
  await openAgentRoute(page, subject);
  await expectStatus(page, subject.workspaceId, "needs_follow_up");
  await selectSidebarStatusGrouping(page);
  const groupedRow = (status: string) =>
    page
      .getByTestId(`sidebar-status-group-rows-${status}`)
      .getByTestId(`sidebar-workspace-row-${getServerId()}:${subject.workspaceId}`);
  const followUpDot = groupedRow("needs_follow_up").getByTestId("project-status-dot");
  await expect(followUpDot).toBeVisible();
  const readDotColor = await followUpDot.evaluate((dot) => getComputedStyle(dot).backgroundColor);
  const second = await addFinishedAgent(subject);
  await subject.client.sendAgentMessage(second.id, "Another pending result");
  await subject.client.waitForFinish(second.id, 20_000);
  const unreadRow = groupedRow("attention");
  const unreadDot = unreadRow.getByTestId("project-status-dot");
  await expect(unreadDot).toBeVisible();
  await expect(unreadDot).not.toHaveCSS("background-color", readDotColor);
  await expect(unreadRow).toHaveAccessibleName(/Ready to review/);
  await expect(page.getByTestId("sidebar-status-group-attention")).toContainText("1");
  await unreadRow.hover();
  const mixedStatus = "1 Ready to review · 1 Needs follow-up";
  await expect(page.getByTestId("hover-card-workspace-status")).toHaveText(mixedStatus);
  await page.getByTestId(`sidebar-workspace-kebab-${getServerId()}:${subject.workspaceId}`).click();
  await expect(page.getByTestId("workspace-menu-chat-status")).toHaveText(mixedStatus);
  await page.getByRole("menuitem", { name: "Mark all as read", exact: true }).click();
  await expect(groupedRow("needs_follow_up")).toBeVisible();
  await expect(page.getByTestId("sidebar-status-group-needs_follow_up")).toContainText("2");
  await chooseChatReviewAction(page, subject.workspaceId, second.id, "mark-as-unread");
  await expect(groupedRow("attention")).toBeVisible();
  await chooseChatReviewAction(page, subject.workspaceId, second.id, "mark-as-read");
  await expect(groupedRow("needs_follow_up")).toBeVisible();
  await expectSelectedAgent(page, subject.agentId);
  await chooseChatReviewAction(page, subject.workspaceId, second.id, "mark-done");
  await expect(groupedRow("needs_follow_up")).toBeVisible();
  await chooseChatReviewAction(page, subject.workspaceId, second.id, "mark-for-follow-up");
  await expect(
    page
      .getByTestId(`workspace-tab-agent_${second.id}`)
      .filter({ visible: true })
      .getByTestId("agent-status-dot"),
  ).toBeVisible();
  await chooseChatReviewAction(page, subject.workspaceId, second.id, "mark-done");
  await page.reload();
  await page.getByTestId("composer-mark-done").click();
  await expect(groupedRow("done")).toBeVisible();
  await expect(page.getByTestId("composer-mark-done")).toHaveCount(0);
  await workspaceRow(page, subject.workspaceId).hover();
  await page.getByTestId(`sidebar-workspace-kebab-${getServerId()}:${subject.workspaceId}`).click();
  await expect(page.getByRole("menuitem", { name: "Mark as unread", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await chooseChatReviewAction(page, subject.workspaceId, subject.agentId, "mark-as-unread");
  await expect(groupedRow("attention")).toBeVisible();
  const reopenedPill = page.getByTestId("composer-mark-done");
  await expect(reopenedPill).toHaveAccessibleName("Ready to review · Mark done");
  const tabId = `agent_${subject.agentId}`;
  const chatTab = page.getByTestId(`workspace-tab-${tabId}`).filter({ visible: true });
  await chatTab.click({ button: "right" });
  await expect(
    page.getByTestId(`workspace-tab-context-${tabId}-mark-done`).filter({ visible: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(groupedRow("attention")).toBeVisible();
  await chatTab.click();
  await expect(groupedRow("needs_follow_up")).toBeVisible();
  await expect(reopenedPill).toHaveAccessibleName("Needs follow-up · Mark done");
  await reopenedPill.click();
  await expect(groupedRow("done")).toBeVisible();
});
