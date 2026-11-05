import type { Page, WebSocket } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { openAgentRoute } from "../support/helpers/mock-agent";
import {
  readReactRenders,
  recordReactRenders,
  resetReactRenders,
} from "../support/helpers/react-renders";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

function recordFramesContaining(page: Page, text: string): string[] {
  const frames: string[] = [];
  const onFrame = ({ payload }: { payload: string | Buffer }) => {
    if (typeof payload === "string" && payload.includes(text)) frames.push(payload);
  };
  page.on("websocket", (socket: WebSocket) => socket.on("framereceived", onFrame));
  return frames;
}

test.describe("Workspace screen and unrelated agent updates", () => {
  let open: SeededWorkspace;
  let elsewhere: SeededWorkspace;

  test.beforeAll(async () => {
    open = await seedWorkspace({ repoPrefix: "unrelated-update-open-", title: "Open" });
    elsewhere = await seedWorkspace({ repoPrefix: "unrelated-update-other-", title: "Other" });
  });

  test.afterAll(async () => {
    await open?.cleanup();
    await elsewhere?.cleanup();
  });

  test("an agent update in another workspace does not re-render the open workspace", async ({
    page,
  }) => {
    const tabAgent = await open.client.createAgent({
      provider: "mock",
      cwd: open.repoPath,
      workspaceId: open.workspaceId,
      title: "Open tab",
      modeId: "load-test",
      model: "e2e-fast-stream",
    });
    const other = await elsewhere.client.createAgent({
      provider: "mock",
      cwd: elsewhere.repoPath,
      workspaceId: elsewhere.workspaceId,
      title: "Other agent",
      modeId: "load-test",
      model: "e2e-fast-stream",
    });
    const renameFrames = recordFramesContaining(page, "Renamed elsewhere");
    await recordReactRenders(page);
    await openAgentRoute(page, { workspaceId: open.workspaceId, agentId: tabAgent.id });
    await expect(page.getByTestId(`workspace-tab-agent_${tabAgent.id}`).first()).toBeVisible();

    await resetReactRenders(page);
    await elsewhere.client.updateAgent(other.id, { name: "Renamed elsewhere" });
    // Wait for the rename to reach the app, then let React commit it before reading counts.
    await expect.poll(() => renameFrames.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.waitForTimeout(500);

    const renders = await readReactRenders(page);
    expect(renders.WorkspaceScreenContent ?? 0).toBe(0);
  });
});
