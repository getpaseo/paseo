import { expect, test } from "../support/fixtures";
import { openAgentRoute } from "../support/helpers/mock-agent";
import {
  captureHeartbeatEvidence,
  deleteHeartbeat,
  expectHeartbeatDetails,
  expectHeartbeatVisible,
  expectWorkspaceDone,
  expectWorkspaceRunning,
  openHeartbeat,
  openHeartbeatAndSubagentTracks,
  openHeartbeatTrack,
  removeSeededSubagent,
  returnToAgentHeartbeat,
  seedAgentWithHeartbeat,
} from "../support/helpers/heartbeats";

test("an agent heartbeat stays visible and keeps its workspace running", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const scenario = await seedAgentWithHeartbeat();

  try {
    await openAgentRoute(page, {
      workspaceId: scenario.workspace.workspaceId,
      agentId: scenario.parent.id,
    });
    await expectWorkspaceDone(page);
    const heartbeat = await scenario.createHeartbeat();
    await expectWorkspaceRunning(page);
    await openHeartbeatAndSubagentTracks(page, heartbeat, scenario.child.id);
    await expectHeartbeatVisible(page, heartbeat);
    await captureHeartbeatEvidence(page, testInfo, "heartbeat-stacked-tracks");

    await openHeartbeat(page, heartbeat);
    await expectHeartbeatDetails(page, heartbeat);
    await captureHeartbeatEvidence(page, testInfo, "heartbeat-schedule-details");

    await removeSeededSubagent(scenario);
    await returnToAgentHeartbeat(page);
    await expectWorkspaceRunning(page);
    await openHeartbeatTrack(page, heartbeat);
    await deleteHeartbeat(page, heartbeat);
    await expect
      .poll(() => scenario.readHeartbeatExists(heartbeat.id), { timeout: 30_000 })
      .toBe(false);
    await expect(scenario.readAgentStatuses()).resolves.toMatchObject({
      [scenario.parent.id]: "idle",
    });
    await expect.poll(scenario.readWorkspaceStatus, { timeout: 30_000 }).toBe("done");
    await expectWorkspaceDone(page);
    await captureHeartbeatEvidence(page, testInfo, "heartbeat-removed-workspace-done");

    const expiringHeartbeat = await scenario.createHeartbeat({ name: "Temporary watch" });
    await expectWorkspaceRunning(page);
    await openHeartbeatTrack(page, expiringHeartbeat);
    await expectHeartbeatVisible(page, expiringHeartbeat);
    await scenario.setHeartbeatExpiry(
      expiringHeartbeat.id,
      new Date(Date.now() + 20_000).toISOString(),
    );
    await expect(page.getByRole("button", { name: "1 heartbeat" })).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect.poll(scenario.readWorkspaceStatus, { timeout: 30_000 }).toBe("done");
    await expectWorkspaceDone(page);
  } finally {
    await scenario.cleanup().catch(() => undefined);
  }
});
