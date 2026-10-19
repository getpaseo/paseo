import { test, expect } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  openModelPicker,
  drillIntoProvider,
  seedModelProvider,
} from "../support/helpers/agent-profiles";
import { expectComposerVisible, submitMessage } from "../support/helpers/composer";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const TARGET = {
  id: "switch-test-claude",
  label: "Switch Test Agent",
  models: [
    { id: "switch-test-model", label: "Switch Test Model", description: "Provider switching test" },
  ],
};

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "narrow desktop", width: 900, height: 844 },
]) {
  test(`the native picker switches providers in the same chat and survives reload (${viewport.name})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const provider = await seedModelProvider(TARGET);
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "chat-provider-switch-",
      title: "Switch test",
    });
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "switch-verifier" });
    try {
      await workspace.client.sendAgentMessage(
        workspace.agentId,
        "Remember the migration constraint.",
      );
      await workspace.client.waitForFinish(workspace.agentId);
      await openAgentRoute(page, workspace);
      await expectComposerVisible(page);
      const route = page.url();
      await expect(
        page.getByText("Remember the migration constraint.", { exact: true }).first(),
      ).toBeVisible();
      await openModelPicker(page);
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await drillIntoProvider(page, TARGET.id);
      await page.getByText("Switch Test Model", { exact: true }).last().click();
      await expect
        .poll(async () => (await client.fetchAgent({ agentId: workspace.agentId }))?.agent.provider)
        .toBe(TARGET.id);
      await expect(
        page.getByTestId("combined-model-selector").filter({ visible: true }),
      ).toContainText("Switch Test Model");
      expect(page.url()).toBe(route);
      await expect(
        page.getByText("Remember the migration constraint.", { exact: true }).first(),
      ).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("same-chat-provider-switch.png") });
      await page.reload();
      await expectComposerVisible(page);
      await expect(
        page.getByTestId("combined-model-selector").filter({ visible: true }),
      ).toContainText("Switch Test Model");
      await openModelPicker(page);
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await drillIntoProvider(page, "mock");
      await page.getByText("Ten second stream", { exact: true }).last().click();
      await expect
        .poll(async () => (await client.fetchAgent({ agentId: workspace.agentId }))?.agent.provider)
        .toBe("mock");
      await submitMessage(page, "Continue after switching back.");
      await expect(
        page.getByText("Continue after switching back.", { exact: true }).first(),
      ).toBeVisible();
      await expect(
        page.getByText(
          "Paseo conversation history from the previous agent follows as JSON records.",
          { exact: false },
        ),
      ).toHaveCount(0);
    } finally {
      await client.close();
      await workspace.cleanup();
      await provider.restore();
    }
  });
}

test("a stale model rejection keeps the original chat and shows an actionable error", async ({
  page,
}) => {
  const provider = await seedModelProvider(TARGET);
  const gate = await installDaemonWebSocketGate(page);
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "chat-provider-failure-",
    title: "Switch failure",
  });
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "switch-failure-verifier",
  });
  try {
    await openAgentRoute(page, workspace);
    await expectComposerVisible(page);
    await openModelPicker(page);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await drillIntoProvider(page, TARGET.id);
    // Hold the real request while the host catalog changes, reproducing a
    // stale picker without mocking the daemon's rejection or the UI response.
    gate.holdNextClientRequest("set_agent_model_request");
    await page.getByText("Switch Test Model", { exact: true }).last().click();
    await gate.waitForHeldClientRequest();
    await client.patchDaemonConfig({
      providers: {
        [TARGET.id]: {
          extends: "claude",
          enabled: true,
          command: ["node"],
          label: TARGET.label,
          models: [{ id: "replacement-model", label: "Replacement model" }],
        },
      },
    });
    gate.releaseHeldClientRequest();
    await expect(page.getByTestId("agent-model-change-error")).toBeVisible({ timeout: 30_000 });
    expect((await client.fetchAgent({ agentId: workspace.agentId }))?.agent.provider).toBe("mock");
    await page
      .getByTestId("agent-model-change-error")
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
    await submitMessage(page, "The original agent still works.");
    await expect(
      page.getByText("The original agent still works.", { exact: true }).first(),
    ).toBeVisible();
  } finally {
    await client.close();
    await workspace.cleanup();
    await provider.restore();
  }
});
