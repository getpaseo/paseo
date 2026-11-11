import { buildSeededHost } from "../support/helpers/daemon-registry";
import { submitMessage } from "../support/helpers/composer";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  delegateFleetThroughMcp,
  expectManagedSubagentArchived,
  openSubagentsTrack,
  seedParentWithSubagent,
} from "../support/helpers/subagents";

test.use({ e2eInjectPaseoTools: true });

const SETTINGS_KEY = "@paseo:app-settings";

async function openParentInRightPane(page: Page, parentId: string, workspaceId: string) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openAgentRoute(page, { workspaceId, agentId: parentId });
  await expect(page.getByTestId(`workspace-tab-agent_${parentId}`)).toBeVisible();
  await page.getByTestId("workspace-pane-main").getByTestId("workspace-new-tab-button").click();
  await page.getByTestId("workspace-new-tab-menu-agent").click();
  await page.getByTestId(`workspace-tab-agent_${parentId}`).click();
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  await page
    .getByTestId("workspace-pane-main")
    .getByTestId(`workspace-tab-agent_${parentId}`)
    .click();
  await page.keyboard.press("Meta+Alt+Shift+ArrowRight");

  const left = page.getByTestId("workspace-pane-main");
  const right = page
    .locator('[data-testid^="workspace-pane-"]')
    .filter({ has: page.getByTestId(`workspace-tab-agent_${parentId}`) });
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();
  await expect(right).not.toHaveAttribute("data-testid", "workspace-pane-main");
  await left.locator('[data-testid^="workspace-tab-draft_"]').click();
  return { left, right };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  });
});

test("a subagent opened from a right-pane parent stays with its parent when left has focus", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "subagent-origin-pane-" });
  try {
    const pair = await seedParentWithSubagent(workspace, {
      parentTitle: "Right parent",
      childTitle: "Child agent",
    });
    const { left, right } = await openParentInRightPane(page, pair.parent.id, pair.workspaceId);
    await openSubagentsTrack(page);
    await page.getByTestId(`subagents-track-row-${pair.child.id}`).click();

    await expect(right.getByTestId(`workspace-tab-agent_${pair.child.id}`)).toBeVisible();
    await expect(left.getByTestId(`workspace-tab-agent_${pair.child.id}`)).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});

test("the side preference opens a right-pane parent's subagent in the side pane", async ({
  page,
}) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ openInSidePane: { subagents: true } }));
  }, SETTINGS_KEY);
  const workspace = await seedWorkspace({ repoPrefix: "subagent-side-preference-" });
  try {
    const pair = await seedParentWithSubagent(workspace, {
      parentTitle: "Right parent",
      childTitle: "Child agent",
    });
    const { left, right } = await openParentInRightPane(page, pair.parent.id, pair.workspaceId);
    await openSubagentsTrack(page);
    await page.getByTestId(`subagents-track-row-${pair.child.id}`).click();

    const childPane = page
      .locator('[data-testid^="workspace-pane-"]')
      .filter({ has: page.getByTestId(`workspace-tab-agent_${pair.child.id}`) });
    await expect(childPane).toBeVisible();
    expect(await childPane.getAttribute("data-testid")).not.toBe(
      await right.getAttribute("data-testid"),
    );
    await expect(childPane).not.toHaveAttribute("data-testid", "workspace-pane-main");
    await expect(left.getByTestId(`workspace-tab-agent_${pair.child.id}`)).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});

test("opening an already-tabbed subagent reveals its left tab without a duplicate", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "subagent-existing-tab-" });
  try {
    const pair = await seedParentWithSubagent(workspace, {
      parentTitle: "Right parent",
      childTitle: "Child agent",
    });
    const { left, right } = await openParentInRightPane(page, pair.parent.id, pair.workspaceId);
    await openSubagentsTrack(page);
    await page.getByTestId(`subagents-track-row-${pair.child.id}`).click();
    await expect(right.getByTestId(`workspace-tab-agent_${pair.child.id}`)).toBeVisible();
    await page.keyboard.press("Meta+Alt+Shift+ArrowLeft");
    await expect(left.getByTestId(`workspace-tab-agent_${pair.child.id}`)).toBeVisible();
    await right.getByTestId(`workspace-tab-agent_${pair.parent.id}`).click();
    await openSubagentsTrack(page);
    await page.getByTestId(`subagents-track-row-${pair.child.id}`).click();

    await expect(left.getByTestId(`workspace-tab-agent_${pair.child.id}`)).toBeVisible();
    await expect(right.getByTestId(`workspace-tab-agent_${pair.child.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`workspace-tab-agent_${pair.child.id}`)).toHaveCount(1);
  } finally {
    await workspace.cleanup();
  }
});

test("a preferred chat file link still opens beside its right-pane agent", async ({ page }) => {
  const target = "linked.ts:3";
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "chat-file-origin-pane-",
    title: "File link parent",
    initialPrompt: [
      "Generate a title and a git branch name for a coding agent from the user prompt and attachments.",
      "Return JSON only with fields 'title' and 'branch'.",
      "",
      "<user-prompt>",
      `Open \`${target}\` now`,
      "</user-prompt>",
    ].join("\n"),
  });
  try {
    await writeFile(path.join(workspace.cwd, "linked.ts"), "one\ntwo\nthree\n", "utf8");
    const { left, right } = await openParentInRightPane(
      page,
      workspace.agentId,
      workspace.workspaceId,
    );
    const fileLink = right.getByText(target, { exact: true });
    await expect(fileLink).toBeVisible({ timeout: 15_000 });
    await fileLink.click();

    await expect(right.getByTestId("workspace-tab-file_linked.ts")).toBeVisible();
    await expect(left.getByTestId("workspace-tab-file_linked.ts")).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});

test("MCP delegates to self and B and opens both qualified children in ordinary conversations", async ({
  page,
}) => {
  const fleet = await delegateFleetThroughMcp();
  let appSockets = 0;
  let routeOpens = 0;
  const activeDaemonSockets = new Set<unknown>();
  const observationRequests: Record<string, number> = {};
  page.on("websocket", (socket) => {
    appSockets++;
    if (new URL(socket.url()).pathname === "/ws") {
      activeDaemonSockets.add(socket);
      socket.on("close", () => activeDaemonSockets.delete(socket));
    }
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string" || !payload.startsWith("{")) return;
      if (String(payload).includes('"hosts.route.open.request"')) routeOpens++;
      const outer = JSON.parse(String(payload));
      const request = outer.type === "session" ? outer.message : null;
      if (
        request?.type &&
        (request.subscribe !== undefined ||
          request.observe === true ||
          request.type.endsWith("set_subscription.request"))
      )
        observationRequests[request.type] = (observationRequests[request.type] ?? 0) + 1;
    });
  });
  try {
    await openAgentRoute(page, {
      workspaceId: fleet.workspace.workspaceId,
      agentId: fleet.parent.id,
    });
    await openSubagentsTrack(page);
    await expect(page.getByTestId(`subagents-track-row-${fleet.local.agentId}`)).toContainText(
      "MCP child on A",
    );
    await expect(page.getByTestId(`subagents-track-row-${fleet.remote.agentId}`)).toContainText(
      "MCP child on B",
    );
    await expect(page.getByTestId(`subagents-track-row-${fleet.remote.agentId}`)).toContainText(
      "Fleet B",
    );
    await page.getByTestId(`subagents-track-row-${fleet.local.agentId}`).click();
    await expect(page.getByTestId(`workspace-tab-agent_${fleet.local.agentId}`)).toBeVisible();
    await submitMessage(page, "LOCAL_UI_TARGET");
    await expect(page.getByText("LOCAL_UI_TARGET", { exact: true })).toBeVisible();
    expect((await fleet.b.fetchAgent(fleet.local.agentId))?.agent.lastUserMessageAt).toBeNull();
    await page.getByTestId(`workspace-tab-agent_${fleet.parent.id}`).click();
    await openSubagentsTrack(page);
    await page.getByTestId(`subagents-track-row-${fleet.remote.agentId}`).click();
    await expect(page).toHaveURL((url) =>
      url.pathname.includes(`/h/${fleet.remote.serverId}/workspace/`),
    );
    await submitMessage(page, "REMOTE_UI_TARGET");
    await expect(page.getByText("REMOTE_UI_TARGET", { exact: true })).toBeVisible();
    expect((await fleet.a.fetchAgent(fleet.remote.agentId))?.agent.lastUserMessageAt).toBeNull();
    await fleet.expectCompletion(fleet.local);
    await fleet.expectCompletion(fleet.remote);
    await openAgentRoute(page, {
      workspaceId: fleet.workspace.workspaceId,
      agentId: fleet.parent.id,
    });
    await expect(
      page.getByRole("button", { name: /Agent finished.*MCP child on A/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Agent finished.*MCP child on B/ }),
    ).toBeVisible();
    const owners = await page.evaluate(() => {
      const runtime = Reflect.get(globalThis, "__paseoHostRuntimeStore") as {
        getHosts(): Array<{ serverId: string }>;
        getSnapshot(
          serverId: string,
        ): { connectionStatus: string; clientGeneration: number } | null;
      };
      return runtime.getHosts().map((host) => {
        const snapshot = runtime.getSnapshot(host.serverId);
        return {
          serverId: host.serverId,
          connectionStatus: snapshot?.connectionStatus,
          clientGeneration: snapshot?.clientGeneration,
        };
      });
    });
    console.log("Fleet ordinary route counts", {
      appSockets,
      activeDaemonSockets: activeDaemonSockets.size,
      routeOpens,
      owners,
      observationRequests,
    });
  } finally {
    await fleet.close();
  }
});

async function openFleetParentWithDirectB(
  page: Page,
  fleet: Awaited<ReturnType<typeof delegateFleetThroughMcp>>,
) {
  await page.goto("/", { waitUntil: "commit" });
  const host = buildSeededHost({
    serverId: fleet.remote.serverId,
    endpoint: `127.0.0.1:${fleet.destination.port}`,
    label: "Fleet B",
    nowIso: new Date().toISOString(),
  });
  await page.evaluate((extraHost) => {
    localStorage.setItem("@paseo:e2e-extra-hosts", JSON.stringify([extraHost]));
  }, host);
  await openAgentRoute(page, {
    workspaceId: fleet.workspace.workspaceId,
    agentId: fleet.parent.id,
  });
  await openSubagentsTrack(page);
  await expect(page.getByTestId(`subagents-track-row-${fleet.remote.agentId}`)).toContainText(
    "MCP child on B",
  );
}

async function openFleetChild(
  page: Page,
  fleet: Awaited<ReturnType<typeof delegateFleetThroughMcp>>,
) {
  await page.getByTestId(`subagents-track-row-${fleet.remote.agentId}`).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === `/h/${fleet.remote.serverId}/workspace/${fleet.remote.workspaceId}`,
  );
}

test("a directly connected B opens and archives its MCP child from A's track", async ({ page }) => {
  const fleet = await delegateFleetThroughMcp();
  try {
    await openFleetParentWithDirectB(page, fleet);
    await openFleetChild(page, fleet);
    await expect(page.getByRole("button", { name: "MCP child on B", exact: true })).toBeVisible();
    await submitMessage(page, "DIRECT_B_TARGET");
    await expect(page.getByText("DIRECT_B_TARGET", { exact: true })).toBeVisible();
    expect((await fleet.a.fetchAgent(fleet.remote.agentId))?.agent.lastUserMessageAt).toBeNull();
    await openFleetParentWithDirectB(page, fleet);
    await page.getByTestId(`subagents-track-row-${fleet.remote.agentId}`).hover();
    page.once("dialog", (dialog) => {
      void dialog.accept();
    });
    await page.getByRole("button", { name: "Archive MCP child on B", exact: true }).click();
    await expectManagedSubagentArchived({ client: fleet.b }, fleet.remote.agentId);
    await expect(page.getByTestId(`subagents-track-row-${fleet.remote.agentId}`)).toHaveCount(0);
    expect((await fleet.a.fetchAgent(fleet.remote.agentId))?.agent.archivedAt).toBeNull();
    await expect(page.getByText(/already connected through another route/)).toHaveCount(0);
  } finally {
    await fleet.close();
  }
});

test("an unavailable B child opens its cached workspace with existing reconnecting behavior", async ({
  page,
}) => {
  const fleet = await delegateFleetThroughMcp();
  try {
    await openFleetParentWithDirectB(page, fleet);
    await fleet.destination.close();
    await expect
      .poll(() =>
        page.evaluate((serverId) => {
          const runtime = Reflect.get(globalThis, "__paseoHostRuntimeStore") as {
            getSnapshot(id: string): { serverId: string; connectionStatus: string } | null;
          };
          return runtime.getSnapshot(serverId);
        }, fleet.remote.serverId),
      )
      .toMatchObject({
        serverId: fleet.remote.serverId,
        connectionStatus: expect.stringMatching(/^(offline|connecting|error)$/),
      });
    await openFleetChild(page, fleet);
    await expect(page.getByTestId("workspace-header-title").filter({ visible: true })).toHaveText(
      "B workspace",
    );
    await expect(page.getByRole("button", { name: "MCP child on B", exact: true })).toBeVisible();
    await expect(page.getByText(/already connected through another route/)).toHaveCount(0);
  } finally {
    await fleet.close();
  }
});
