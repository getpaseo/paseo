import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import {
  cleanupRewindFlow,
  launchAgent,
  sendMessage,
  type AgentHandle,
  type RewindFlowProvider,
} from "../support/helpers/rewind-flow";
import {
  expectCompletedTaskActivity,
  expectTaskListEntries,
  openCompletedTaskList,
} from "../support/helpers/task-list";
import { submitMessage, submitMessageWithButton } from "../support/helpers/composer";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { gotoAppShell } from "../support/helpers/app";

interface TaskScenario {
  provider: RewindFlowProvider;
  entries: [string, string];
  prompt: string;
  providerConfig?: Parameters<typeof launchAgent>[0]["providerConfig"];
}

const scenarios: TaskScenario[] = [
  {
    provider: "claude",
    entries: ["Claude inventory alpha", "Claude inventory beta"],
    providerConfig: { model: "opus" },
    prompt:
      "Use TaskCreate to create exactly two tasks named Claude inventory alpha and Claude inventory beta. Use TaskUpdate to mark each in_progress and then completed. Do not use subagents, shell commands, or edit files. Finish with TASKS_COMPLETE.",
  },
  {
    provider: "codex",
    entries: ["Codex inventory alpha", "Codex inventory beta"],
    prompt:
      "Use update_plan to track exactly two steps named Codex inventory alpha and Codex inventory beta. Move each through in_progress and completed. Do not use subagents, shell commands, or edit files. Finish with TASKS_COMPLETE.",
  },
  {
    provider: "opencode",
    entries: ["OpenCode inventory alpha", "OpenCode inventory beta"],
    prompt:
      "Use TodoWrite to track exactly two tasks named OpenCode inventory alpha and OpenCode inventory beta. Move each through in_progress and completed. Do not use subagents, shell commands, or edit files. Finish with TASKS_COMPLETE.",
  },
];

test.describe("real provider composer task lists", () => {
  test.setTimeout(600_000);

  for (const scenario of scenarios) {
    test(`${scenario.provider} shows native task progress above the composer`, async ({
      page,
    }, testInfo) => {
      const cwd = realpathSync(
        mkdtempSync(path.join(tmpdir(), `paseo-task-list-${scenario.provider}-`)),
      );
      let handle: AgentHandle | undefined;

      try {
        handle = await launchAgent({
          page,
          provider: scenario.provider,
          cwd,
          mode: "full-access",
          providerConfig: scenario.providerConfig,
        });
        await sendMessage(handle, scenario.prompt);
        await openCompletedTaskList(page, scenario.entries.length);
        await expectTaskListEntries(page, scenario.entries);
        await expectCompletedTaskActivity(page, scenario.entries);
        await expect(page.getByText("TaskUpdate", { exact: true })).toHaveCount(0);
        await expect(page.getByTestId("timeline-plan-card")).toHaveCount(0);

        const screenshot = testInfo.outputPath(`${scenario.provider}-composer-tasks.png`);
        await page.screenshot({ path: screenshot });
        await testInfo.attach(`${scenario.provider} composer tasks`, {
          path: screenshot,
          contentType: "image/png",
        });
      } finally {
        await cleanupRewindFlow({ handle, cwd });
      }
    });
  }

  test("Codex genuine Plan mode keeps the existing plan card", async ({ page }, testInfo) => {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-genuine-codex-plan-")));
    let handle: AgentHandle | undefined;

    try {
      handle = await launchAgent({
        page,
        provider: "codex",
        cwd,
        mode: "full-access",
        providerConfig: { featureValues: { plan_mode: true } },
      });
      await submitMessage(
        page,
        "Produce a concise implementation plan with exactly these steps: Inspect genuine plan boundary; Implement genuine plan boundary; Verify genuine plan boundary. Do not implement it.",
      );

      const planCard = page.getByTestId("permission-plan-card");
      await expect(planCard).toBeVisible({ timeout: 120_000 });
      await expect(planCard).toContainText("Inspect genuine plan boundary");
      await expect(page.getByTestId("timeline-plan-card")).toHaveCount(0);

      const screenshot = testInfo.outputPath("codex-genuine-plan.png");
      await page.screenshot({ path: screenshot });
      await testInfo.attach("Codex genuine plan", { path: screenshot, contentType: "image/png" });
    } finally {
      await cleanupRewindFlow({ handle, cwd });
    }
  });
});

async function openBackgroundInventory(
  page: Page,
  options: { compact: boolean; count: number; timeout: number },
): Promise<Locator> {
  const pill = page.getByRole("button", {
    name: options.count === 1 ? "1 background task" : `${options.count} background tasks`,
  });
  await expect(pill).toBeVisible({ timeout: options.timeout });
  await pill.click();
  const panel = page.getByTestId(
    options.compact ? "background-work-panel-content" : "background-work-panel",
  );
  if (options.compact) await waitForSettledPosition(panel);
  return panel;
}

async function openBackgroundWork(page: Page, compact: boolean): Promise<void> {
  const panel = await openBackgroundInventory(page, { compact, count: 1, timeout: 30_000 });
  await expect(panel).toContainText(/sleep 120/);
}

async function expectBackgroundItems(
  panel: Locator,
  selected: string,
  sibling: string,
): Promise<void> {
  await expect(panel).toContainText(selected);
  await expect(panel).toContainText(sibling);
}

async function stopBackgroundItem(panel: Locator, selected: string): Promise<void> {
  const escaped = selected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await panel.getByRole("button", { name: new RegExp(`Stop .*${escaped}`) }).click();
}

async function expectStoppedItemAndSibling(
  panel: Locator,
  selected: string,
  sibling: string,
): Promise<void> {
  await expect(panel).not.toContainText(selected, { timeout: 40_000 });
  await expect(panel).toContainText(sibling);
}

async function closeBackgroundWork(page: Page, compact: boolean): Promise<void> {
  const panel = page.getByTestId(
    compact ? "background-work-panel-content" : "background-work-panel",
  );
  if (compact) {
    await page
      .getByRole("button", { name: "Bottom sheet backdrop" })
      .click({ position: { x: 12, y: 12 } });
  } else {
    await page.keyboard.press("Escape");
  }
  await expect(panel).toBeHidden();
}

async function expectBackgroundAgentRunning(page: Page): Promise<void> {
  await expect(page.getByTestId("workspace-status-indicator-running").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toHaveCount(0);
}

async function expectAssistantReply(page: Page, text: string): Promise<void> {
  await expect(page.getByTestId("assistant-message").filter({ hasText: text }).last()).toBeVisible({
    timeout: 120_000,
  });
}

async function expectBackgroundPill(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "1 background task" })).toBeVisible();
}

async function expectBackgroundWorkOnAnotherClient(page: Page): Promise<void> {
  const another = await page.context().newPage();
  try {
    await another.goto(page.url());
    await openBackgroundWork(another, false);
  } finally {
    await another.close();
  }
}

async function startBackgroundWorkWithoutOpeningPane(workspace: SeededWorkspace): Promise<void> {
  const agent = await workspace.client.createAgent({
    provider: "claude",
    model: "haiku",
    modeId: "bypassPermissions",
    cwd: workspace.workspaceDirectory,
    workspaceId: workspace.workspaceId,
    title: "Background work before opening",
  });
  await workspace.client.sendAgentMessage(
    agent.id,
    "Use Bash with run_in_background to run exactly sleep 120. Do not wait for it. Reply SPAWNED immediately.",
  );
  const result = await workspace.client.waitForFinish(agent.id, 120_000);
  expect(result.status).toBe("idle");
}

async function expectWorkspaceRunning(page: Page, workspaceId: string): Promise<void> {
  const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
  await expect(row.getByTestId("workspace-status-indicator-running")).toBeVisible({
    timeout: 30_000,
  });
}

test("Claude keeps background work visible while accepting another turn", async ({ page }) => {
  test.setTimeout(300_000);
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-background-work-")));
  let handle: AgentHandle | undefined;
  try {
    handle = await launchAgent({ page, provider: "claude", cwd, mode: "full-access" });
    await sendMessage(
      handle,
      "Use Bash with run_in_background to run exactly sleep 120. Do not wait for it. Reply SPAWNED immediately.",
    );
    await expectBackgroundAgentRunning(page);
    await openBackgroundWork(page, false);
    await page.screenshot({
      path: path.resolve("../../.artifacts/phase1-claude-background.png"),
      animations: "disabled",
    });
    await closeBackgroundWork(page, false);
    await sendMessage(handle, "Reply exactly HELLO without stopping the background command.");
    await expectBackgroundPill(page);
    await expectBackgroundWorkOnAnotherClient(page);
  } finally {
    await cleanupRewindFlow({ handle, cwd });
  }
});

test("Claude background work remains readable in dark mode", async ({ page }) => {
  test.setTimeout(300_000);
  await page.addInitScript(() => {
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "pureBlack" }));
  });
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-background-dark-")));
  let handle: AgentHandle | undefined;
  try {
    handle = await launchAgent({ page, provider: "claude", cwd, mode: "full-access" });
    await sendMessage(
      handle,
      "Use Bash with run_in_background to run exactly sleep 120. Do not wait for it. Reply SPAWNED immediately.",
    );
    await openBackgroundWork(page, false);
    await page.screenshot({
      path: path.resolve("../../.artifacts/review-background-dark.png"),
      animations: "disabled",
    });
  } finally {
    await cleanupRewindFlow({ handle, cwd });
  }
});

test("Claude background work opens in a compact sheet", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-background-compact-")));
  let handle: AgentHandle | undefined;
  try {
    handle = await launchAgent({ page, provider: "claude", cwd, mode: "full-access" });
    await submitMessageWithButton(
      page,
      "Use Bash with run_in_background to run exactly sleep 120. Do not wait for it. Reply SPAWNED immediately.",
    );
    await expectAssistantReply(page, "SPAWNED");
    await openBackgroundWork(page, true);
    await page.screenshot({
      path: path.resolve("../../.artifacts/phase1-claude-compact.png"),
      animations: "disabled",
    });
    await closeBackgroundWork(page, true);
    await submitMessageWithButton(
      page,
      "Reply exactly HELLO without stopping the background command.",
    );
    await expectAssistantReply(page, "HELLO");
    await expectBackgroundPill(page);
  } finally {
    await cleanupRewindFlow({ handle, cwd });
  }
});

test("background work updates the sidebar before the agent is opened", async ({ page }) => {
  test.setTimeout(300_000);
  const workspace = await seedWorkspace({ repoPrefix: "background-unopened-" });
  try {
    await gotoAppShell(page);
    await expect(
      page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`),
    ).toBeVisible();
    await startBackgroundWorkWithoutOpeningPane(workspace);
    await expectWorkspaceRunning(page, workspace.workspaceId);
  } finally {
    await workspace.cleanup();
  }
});

test("Codex keeps a live command visible after its turn", async ({ page }) => {
  test.setTimeout(300_000);
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-codex-background-")));
  let handle: AgentHandle | undefined;
  try {
    handle = await launchAgent({
      page,
      provider: "codex",
      cwd,
      mode: "full-access",
      providerConfig: { model: "gpt-6-astra" },
    });
    await sendMessage(
      handle,
      "Use exec_command to run sleep 120 with yield_time_ms 1000. Do not wait for or stop it. Reply SPAWNED immediately.",
    );
    await expectBackgroundAgentRunning(page);
    await openBackgroundWork(page, false);
    await page.screenshot({
      path: path.resolve("../../.artifacts/phase2-codex-background.png"),
      animations: "disabled",
    });
    await closeBackgroundWork(page, false);
    await sendMessage(handle, "Reply exactly HELLO without stopping the background command.");
    await expectBackgroundPill(page);
    await expectBackgroundWorkOnAnotherClient(page);
  } finally {
    await cleanupRewindFlow({ handle, cwd });
  }
});

test("OpenCode keeps a live command visible after its turn", async ({ page }) => {
  test.setTimeout(300_000);
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-opencode-background-")));
  let handle: AgentHandle | undefined;
  try {
    handle = await launchAgent({
      page,
      provider: "opencode",
      cwd,
      mode: "full-access",
      providerConfig: { model: "openrouter/google/gemini-3.6-flash" },
    });
    await sendMessage(
      handle,
      "Use the shell tool with background true to run sleep 120. Do not wait or stop it. Reply SPAWNED immediately.",
    );
    await expectBackgroundAgentRunning(page);
    await openBackgroundWork(page, false);
    await page.screenshot({
      path: path.resolve("../../.artifacts/phase2-opencode-background.png"),
      animations: "disabled",
    });
    await closeBackgroundWork(page, false);
    await sendMessage(handle, "Reply exactly HELLO without stopping the background command.");
    await expectBackgroundPill(page);
    await expectBackgroundWorkOnAnotherClient(page);
  } finally {
    await cleanupRewindFlow({ handle, cwd });
  }
});

for (const scenario of [
  {
    provider: "claude" as const,
    prompt:
      "Use Bash with run_in_background to start sleep 180 and sleep 181 as two separate background commands. Do not wait for them. Reply SPAWNED immediately.",
    providerConfig: { model: "haiku" },
  },
  {
    provider: "codex" as const,
    prompt:
      "Use exec_command twice to start sleep 180 and sleep 181 separately with yield_time_ms 1000. Do not wait for or stop either process. Reply SPAWNED immediately.",
    providerConfig: { model: "gpt-6-astra" },
  },
  {
    provider: "opencode" as const,
    prompt:
      "Use the shell tool twice with background true: start sleep 180, then start sleep 181. Do not wait for or stop either. Reply SPAWNED immediately.",
    providerConfig: { model: "openrouter/google/gemini-3.6-flash" },
  },
]) {
  test(`${scenario.provider} stops selected background work after the turn`, async ({ page }) => {
    test.setTimeout(300_000);
    mkdirSync(path.resolve("../../.artifacts"), { recursive: true });
    const cwd = realpathSync(mkdtempSync(path.resolve("../../.artifacts/phase3-qa-workspace-")));
    let handle: AgentHandle | undefined;
    try {
      handle = await launchAgent({
        page,
        provider: scenario.provider,
        cwd,
        mode: "full-access",
        providerConfig: scenario.providerConfig,
      });
      await sendMessage(handle, scenario.prompt);
      const panel = await openBackgroundInventory(page, {
        compact: false,
        count: 2,
        timeout: 60_000,
      });
      await expectBackgroundItems(panel, "sleep 180", "sleep 181");
      await stopBackgroundItem(panel, "sleep 180");
      await expectStoppedItemAndSibling(panel, "sleep 180", "sleep 181");
      await page.screenshot({
        path: path.resolve(`../../.artifacts/phase3-${scenario.provider}-stop.png`),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await sendMessage(handle, "Reply exactly HELLO without stopping the background command.");
      await expectBackgroundPill(page);
    } finally {
      await cleanupRewindFlow({ handle, cwd });
    }
  });
}

test("Claude stops a selected monitor in the compact sheet", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 390, height: 844 });
  mkdirSync(path.resolve("../../.artifacts"), { recursive: true });
  const cwd = realpathSync(mkdtempSync(path.resolve("../../.artifacts/phase3-monitor-workspace-")));
  let handle: AgentHandle | undefined;
  try {
    handle = await launchAgent({
      page,
      provider: "claude",
      cwd,
      mode: "full-access",
      providerConfig: { model: "opus" },
    });
    await submitMessageWithButton(
      page,
      'Use exactly two separate Monitor tool calls, each with command `sleep 150`, timeout_ms 150000, persistent false, descriptions "probe monitor one" and "probe monitor two". Launch both independently, do not wait, then reply SPAWNED. Do not use any other tools.',
    );
    await expectAssistantReply(page, "SPAWNED");
    const panel = await openBackgroundInventory(page, { compact: true, count: 2, timeout: 30_000 });
    await expectBackgroundItems(panel, "probe monitor one", "probe monitor two");
    await expect(panel.getByText("sleep 150", { exact: true })).toHaveCount(2);
    await page.screenshot({
      path: path.resolve("../../.artifacts/refinement-monitor-compact.png"),
      animations: "disabled",
    });
    await stopBackgroundItem(panel, "probe monitor one");
    await expectStoppedItemAndSibling(panel, "probe monitor one", "probe monitor two");
    await page.screenshot({
      path: path.resolve("../../.artifacts/phase3-claude-monitor-compact.png"),
      animations: "disabled",
    });
    await closeBackgroundWork(page, true);
    await submitMessageWithButton(
      page,
      "Reply exactly HELLO without stopping the background monitor.",
    );
    await expectAssistantReply(page, "HELLO");
    await expectBackgroundPill(page);
    await handle.client.sendAgentMessage(
      handle.agentId,
      "Use Bash to run sleep 20 in the foreground, then reply WAITED.",
    );
    await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await handle.client.sendAgentMessage(
      handle.agentId,
      "Reply exactly INTERRUPTED without stopping the background monitor.",
      { activeTurnBehavior: "interrupt" },
    );
    expect((await handle.client.waitForFinish(handle.agentId, 120_000)).status).toBe("idle");
    await expectBackgroundPill(page);
    await expect
      .poll(async () => handle!.client.listAgentBackgroundWork(handle!.agentId))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ description: "probe monitor two", kind: "monitor" }),
        ]),
      );
  } finally {
    await cleanupRewindFlow({ handle, cwd });
  }
});

test("Claude shows monitor description and command in the wide track", async ({ page }) => {
  test.setTimeout(300_000);
  const cwd = realpathSync(
    mkdtempSync(path.resolve("../../.artifacts/refinement-wide-workspace-")),
  );
  let handle: AgentHandle | undefined;
  try {
    handle = await launchAgent({
      page,
      provider: "claude",
      cwd,
      mode: "full-access",
      providerConfig: { model: "opus" },
    });
    await sendMessage(
      handle,
      'Use Monitor with command `sleep 150`, timeout_ms 150000, persistent false, description "Watch the build". Do not wait; reply SPAWNED. Do not use other tools.',
    );
    await expectBackgroundAgentRunning(page);
    const workspaceRow = page.getByTestId(
      `sidebar-workspace-row-${getServerId()}:${handle.workspaceId}`,
    );
    await workspaceRow.scrollIntoViewIfNeeded();
    await expect(workspaceRow.getByTestId("workspace-status-indicator-running")).toBeVisible();
    const panel = await openBackgroundInventory(page, {
      compact: false,
      count: 1,
      timeout: 30_000,
    });
    await expect(panel).toContainText("Watch the build");
    await expect(panel).toContainText("sleep 150");
    await expect(panel.getByRole("button", { name: "Stop Watch the build" })).toBeVisible();
    await page.screenshot({
      path: path.resolve("../../.artifacts/refinement-monitor-wide.png"),
      animations: "disabled",
    });
  } finally {
    await cleanupRewindFlow({ handle, cwd });
  }
});
