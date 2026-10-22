import { expect, test } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { submitMessageWithButton } from "../support/helpers/composer";
import {
  captureUsageLimit,
  holdUsageLimitSave,
  emitSyntheticUsageLimit,
  openUsageLimitChat,
  reloadUsageLimitChat,
  setUsageLimitResume,
  usageLimitResumeSwitch,
} from "../support/helpers/usage-limit-resume";

for (const viewport of [
  { name: "wide", width: 1280, height: 900 },
  { name: "compact", width: 390, height: 844 },
]) {
  test(`usage limit opt-in survives reload and can be cancelled (${viewport.name})`, async ({
    page,
  }, testInfo) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "usage-limit-",
      title: "Interrupted task",
    });
    try {
      await openUsageLimitChat({ page, agent, viewport });
      await emitSyntheticUsageLimit({
        page,
        resetsAt: new Date(Date.now() + 300_000).toISOString(),
      });
      const toggle = usageLimitResumeSwitch(page);
      await expect(page.getByText("Retry available at", { exact: false })).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await captureUsageLimit({
        page,
        testInfo,
        name: `limit-disabled-${viewport.name}.png`,
        colorScheme: "light",
      });
      await setUsageLimitResume({ page, enabled: true });
      await expect(page.getByText("Will continue at", { exact: false })).toBeVisible();
      await reloadUsageLimitChat(page);
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await expect(page.getByText("Will continue at", { exact: false })).toBeVisible();
      await captureUsageLimit({
        page,
        testInfo,
        name: `limit-enabled-${viewport.name}.png`,
        colorScheme: "light",
      });
      await captureUsageLimit({
        page,
        testInfo,
        name: `limit-enabled-${viewport.name}-dark.png`,
        colorScheme: "dark",
      });
      await setUsageLimitResume({ page, enabled: false });
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await expect(page.getByText("Retry available at", { exact: false })).toBeVisible();
      await submitMessageWithButton(page, "Continue manually");
      await expect(toggle).toHaveCount(0);
    } finally {
      await agent.cleanup();
    }
  });
}

test("overdue opt-in continues the same chat once", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "usage-limit-due-",
    title: "Resume this task",
  });
  try {
    await openAgentRoute(page, agent);
    await emitSyntheticUsageLimit({
      page,
      resetsAt: new Date(Date.now() - 120_000).toISOString(),
    });
    const toggle = usageLimitResumeSwitch(page);
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await setUsageLimitResume({ page, enabled: true });
    await expect(page.getByText("Enabled for this chat", { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("The usage limit reset.", { exact: false })).toHaveCount(1);
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await setUsageLimitResume({ page, enabled: false });
    await expect(toggle).toHaveCount(0);
  } finally {
    await agent.cleanup();
  }
});

test("missing reset time leaves manual continuation available", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "usage-limit-unknown-",
    title: "Unknown reset",
  });
  try {
    await openAgentRoute(page, agent);
    await emitSyntheticUsageLimit({ page, resetsAt: null });
    await expect(page.getByText("did not report a reset time", { exact: false })).toBeVisible();
    await expect(usageLimitResumeSwitch(page)).toBeDisabled();
    await submitMessageWithButton(page, "Continue manually");
    await expect(usageLimitResumeSwitch(page)).toHaveCount(0);
  } finally {
    await agent.cleanup();
  }
});

test("failed opt-in keeps an error visible and permits retry on a narrow screen", async ({
  page,
}, testInfo) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "usage-limit-save-",
    title: "Retry preference",
  });
  try {
    const save = await holdUsageLimitSave({ page, agentId: agent.agentId });
    await openUsageLimitChat({ page, agent, viewport: { width: 320, height: 844 } });
    await emitSyntheticUsageLimit({ page, resetsAt: new Date(Date.now() + 300000).toISOString() });
    await setUsageLimitResume({ page, enabled: true });
    await save.waitForRequest();
    await expect(usageLimitResumeSwitch(page)).toBeDisabled();
    await expect(page.getByText("Saving…", { exact: true })).toBeVisible();
    await captureUsageLimit({ page, testInfo, name: "pending-compact.png", colorScheme: "light" });
    save.reject();
    await expect(
      page.getByText("Could not save this setting. Try again.", { exact: false }),
    ).toBeVisible();
    await expect(usageLimitResumeSwitch(page)).toHaveAttribute("aria-checked", "false");
    await captureUsageLimit({ page, testInfo, name: "error-compact.png", colorScheme: "dark" });
    await setUsageLimitResume({ page, enabled: true });
    await expect(page.getByText("Will continue at", { exact: false })).toBeVisible();
    await expect(
      page.getByText("Could not save this setting. Try again.", { exact: false }),
    ).toHaveCount(0);
  } finally {
    await agent.cleanup();
  }
});
