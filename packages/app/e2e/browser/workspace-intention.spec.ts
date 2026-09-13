import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import {
  connectNewWorkspaceDaemonClient,
  fillNewWorkspaceDraft,
  openNewWorkspaceComposer,
  selectWorkspaceIsolation,
} from "../support/helpers/new-workspace";
import { selectLaunchOption } from "../support/helpers/new-workspace-launch";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

test.use({
  e2eDaemonConfig: {
    version: 1,
    daemon: {
      agentProfiles: [
        {
          id: "paseo-workflow-router",
          name: "Router",
          provider: "mock",
          model: "ten-second-stream",
          featureValues: {},
        },
      ],
    },
  },
});

test("intention creates an empty workspace, persists an unsent Router draft and edits explicitly", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const project = await seedWorkspace({ repoPrefix: "intention-" });
  const client = await connectNewWorkspaceDaemonClient();
  const requests: Array<Record<string, unknown>> = [];
  let rejectEdit = true;
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const envelope = JSON.parse(String(message));
      const request = envelope.type === "session" ? envelope.message : null;
      if (request) requests.push(request);
      if (rejectEdit && request?.type === "workspace.intent.set.request") {
        rejectEdit = false;
        socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "workspace.intent.set.response",
              payload: {
                requestId: request.requestId,
                workspaceId: request.workspaceId,
                accepted: false,
                intent: null,
                error: "Intention edit rejected",
              },
            },
          }),
        );
      } else {
        server.send(message);
      }
    });
    server.onMessage((message) => socket.send(message));
  });
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, project);
    await selectWorkspaceIsolation(page, "local");
    await selectLaunchOption(page, "intention");
    const intention = "  Build a calendar\n  ";
    await fillNewWorkspaceDraft(page, intention);
    await page.getByTestId("workspace-create-submit").click();
    await page.waitForURL((url) => url.pathname.includes("/workspace/"));
    const composer = page
      .getByRole("textbox", { name: "Message agent..." })
      .filter({ visible: true });
    await expect(composer).toHaveValue(intention);
    expect(requests.filter((request) => request.type === "create_agent_request")).toEqual([]);
    const created = (await client.fetchWorkspaces()).entries.find(
      (workspace) => workspace.intent === intention,
    );
    expect(created?.intent).toBe(intention);
    expect(
      (await client.fetchAgents()).entries.filter(
        (entry) => entry.agent.workspaceId === created?.id,
      ),
    ).toEqual([]);
    await page.reload();
    await expect(composer).toHaveValue(intention);
    await expect(page.getByText("Router", { exact: true }).first()).toBeVisible();
    await page.getByTestId("workspace-header-menu-trigger").click();
    await page.getByTestId("workspace-header-edit-intention").click();
    await expect(page.getByTestId("workspace-intention-input")).toHaveValue(intention);
    await page.getByTestId("workspace-intention-input").fill("Calendar for the team");
    await page.getByTestId("workspace-intention-save").click();
    await expect(page.getByTestId("workspace-intention-editor").getByRole("alert")).toHaveText(
      "Intention edit rejected",
    );
    await expect(page.getByTestId("workspace-intention-input")).toHaveValue(
      "Calendar for the team",
    );
    await expect(page.getByTestId("workspace-intention-save")).toBeEnabled();
    await page.getByTestId("workspace-intention-save").click();
    await expect(page.getByTestId("workspace-intention-editor")).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await client.fetchWorkspaces()).entries.find((workspace) => workspace.id === created?.id)
            ?.intent,
      )
      .toBe("Calendar for the team");
    await expect(composer).toHaveValue(intention);
    await composer.press("Enter");
    await expect
      .poll(() => requests.filter((request) => request.type === "create_agent_request").length)
      .toBe(1);
    expect(requests.find((request) => request.type === "create_agent_request")).toMatchObject({
      launchProfileId: "paseo-workflow-router",
      initialPrompt: intention.trim(),
      config: { provider: "mock", model: "ten-second-stream" },
    });
    await expect
      .poll(
        async () =>
          (await client.fetchAgents()).entries.filter(
            (entry) => entry.agent.workspaceId === created?.id,
          ).length,
      )
      .toBe(1);
  } finally {
    await client.close();
    await project.cleanup();
  }
});
