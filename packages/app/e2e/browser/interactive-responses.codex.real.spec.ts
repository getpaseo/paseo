import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scrollTimelineToOldestLoadedEdge } from "../support/helpers/timeline-pagination";
import { expect, test as base } from "../support/fixtures";
import {
  launchAgent,
  sendMessage,
  cleanupRewindFlow,
  type AgentHandle,
} from "../support/helpers/rewind-flow";

const test = base.extend({
  e2eInjectPaseoTools: [true, { scope: "worker" }],
});
test.setTimeout(180000);

test("a real agent creates and consumes an isolated custom visual", async ({
  page,
  e2eWorker,
  e2eWorkerClient,
}, info) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1200, height: 1400 });
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-interactive-real-")));
  let handle: AgentHandle | undefined;
  try {
    handle = await launchAgent({
      page,
      provider: "codex",
      cwd,
      mode: "full-access",
      providerConfig: { model: process.env.E2E_CODEX_MODEL },
    });
    await sendMessage(
      handle,
      'Use render_interactive_response to create exactly one HtmlArtifact custom visual titled "Real calculator". Use its supplied paseo API and inline JavaScript, with a button id "add" labeled "Add: 2". Start from restored state count or 2. Clicking increments count, saves {count}, proposes "Choose 3" when count is 3, and re-renders the label. Do not use document or window. Do not edit files, use shell commands, delegate or call other tools. After rendering, reply "Ready". When the user later submits a choice, read its selected count and reply exactly SELECTED_<count>, without tools.',
    );
    const visual = page.frameLocator('iframe[title="HTML visual"]');
    await visual.getByRole("button", { name: "Add: 2", exact: true }).click();
    await expect(visual.getByRole("button", { name: "Add: 3", exact: true })).toBeVisible();
    const card = page.getByTestId("interactive-response");
    await expect(card.getByText("Choose 3", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Send to agent", exact: true }).click();
    await expect(card.getByRole("button", { name: "Sent", exact: true })).toBeVisible();
    await handle.client.waitForFinish(handle.agentId, 60000);
    await expect(
      page.getByTestId("assistant-message").filter({ hasText: "SELECTED_3" }),
    ).toBeVisible({ timeout: 30000 });
    await e2eWorker.restart();
    await Promise.all([handle.client.connect(), e2eWorkerClient.connect()]);
    await page.reload();
    await expect(
      page.getByTestId("assistant-message").filter({ hasText: "SELECTED_3" }),
    ).toBeVisible({ timeout: 30000 });
    const verificationClient = await connectDaemonClient<DaemonClient>({
      clientIdPrefix: "interactive-restored-history",
    });
    try {
      const restored = await verificationClient.fetchAgentTimeline(handle.agentId, { limit: 200 });
      const submitted = restored.entries.findLast((entry) => entry.item.type === "user_message");
      expect(submitted?.item).toMatchObject({ type: "user_message", text: "Choose 3" });
    } finally {
      await verificationClient.close();
    }
    await scrollTimelineToOldestLoadedEdge(page);
    await expect(visual.getByRole("button", { name: "Add: 3", exact: true })).toBeVisible();
    await card.screenshot({ path: info.outputPath("interactive-real-agent.png") });
  } finally {
    await cleanupRewindFlow({ cwd, handle });
  }
});
