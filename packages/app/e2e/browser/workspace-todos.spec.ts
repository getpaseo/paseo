import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { switchWorkspaceViaSidebar } from "../support/helpers/workspace-ui";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";

test.use({ video: "off", trace: "off" });

async function addTask(
  page: import("@playwright/test").Page,
  title: string,
  notes = "",
  milestone = "",
) {
  await page.getByTestId("workspace-todos-new-title").filter({ visible: true }).fill(title);
  await page.getByTestId("workspace-todos-add-details").filter({ visible: true }).click();
  await page.getByTestId("workspace-todos-new-notes").filter({ visible: true }).fill(notes);
  await page.getByTestId("workspace-todos-new-milestone").filter({ visible: true }).fill(milestone);
  await page.getByTestId("workspace-todos-add").filter({ visible: true }).click();
  await expect(
    page.locator('[data-testid^="workspace-todo-label-"]').filter({ visible: true }).last(),
  ).toHaveText(title);
  await page.getByTestId("workspace-todos-add-details").filter({ visible: true }).click();
}

test("Jalons docks beside navigation, edits milestones, reorders tasks and preserves workspace drafts", async ({
  page,
}, testInfo) => {
  const first = await seedWorkspace({ repoPrefix: "todo-directory-", git: false });
  const second = await seedWorkspace({ repoPrefix: "todo-other-", git: false });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await gotoAppShell(page);
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: first.workspaceId,
    });
    await page.getByTestId("workspace-todos-toggle").filter({ visible: true }).click();
    const panel = page.getByTestId("workspace-todos-panel").filter({ visible: true });
    await expect(panel).toBeVisible();
    await addTask(
      page,
      "Prepare the shared plan",
      "Keep project steps visible to all agents.",
      "Delivery",
    );
    await addTask(page, "Validate the implementation", "", "Delivery");
    const saved = (await first.client.getWorkspaceTodos(first.workspaceId)).list;
    const id = saved.tasks[0]!.id,
      secondId = saved.tasks[1]!.id;
    expect(saved.tasks.map((task) => task.milestone)).toEqual(["Delivery", "Delivery"]);
    await page.getByTestId(`workspace-todo-notes-toggle-${id}`).click();
    await expect(page.getByTestId(`workspace-todo-notes-${id}`)).toHaveValue(
      "Keep project steps visible to all agents.",
    );
    await page.getByTestId(`workspace-todo-title-${id}`).fill("Prepare the project plan");
    await page
      .getByTestId(`workspace-todo-notes-${id}`)
      .fill("These notes are protected from agent rewrites.");
    await page.getByTestId(`workspace-todo-save-${id}`).click();
    await expect(page.getByTestId(`workspace-todo-save-${id}`)).toBeHidden();
    await page.getByTestId(`workspace-todo-notes-toggle-${id}`).click();
    await page.getByTestId(`workspace-todo-menu-${secondId}`).click();
    await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
    await expect
      .poll(async () => (await first.client.getWorkspaceTodos(first.workspaceId)).list.tasks[0]?.id)
      .toBe(secondId);
    const handle = await page.getByTestId(`workspace-todo-drag-${secondId}`).boundingBox();
    const target = await page.getByTestId(`workspace-todo-drag-${id}`).boundingBox();
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await page.mouse.down();
    await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
    await expect
      .poll(async () =>
        (await first.client.getWorkspaceTodos(first.workspaceId)).list.tasks.map((task) => task.id),
      )
      .toEqual([id, secondId]);
    await page.getByTestId(`workspace-todo-check-${id}`).click();
    await expect(page.getByTestId("workspace-todos-counter").filter({ visible: true })).toHaveText(
      "1/2",
    );
    await expect(page.getByTestId(`workspace-todo-label-${id}`)).toBeHidden();
    await page.getByTestId("workspace-todo-completed-toggle-Delivery").click();
    await expect(page.getByTestId(`workspace-todo-label-${id}`)).toHaveText(
      "Prepare the project plan",
    );
    await page.getByTestId(`workspace-todo-menu-${secondId}`).click();
    await page.getByRole("menuitem", { name: "In progress", exact: true }).click();
    await expect(page.getByTestId(`workspace-todo-status-${secondId}`)).toHaveText("In progress");
    await page.getByTestId(`workspace-todo-notes-toggle-${secondId}`).click();
    await page.getByTestId(`workspace-todo-milestone-input-${secondId}`).fill("Verification");
    await page.getByTestId(`workspace-todo-save-${secondId}`).click();
    await expect(page.getByTestId("workspace-todo-milestone-Verification")).toBeVisible();
    await expect
      .poll(
        async () =>
          (await first.client.getWorkspaceTodos(first.workspaceId)).list.tasks[1]?.milestone,
      )
      .toBe("Verification");
    await page.getByTestId(`workspace-todo-notes-toggle-${secondId}`).click();
    await page.getByTestId("workspace-todos-new-title").fill("Draft survives workspace changes");
    await page.getByTestId("workspace-todos-close").click();
    await expect(panel).toBeHidden();
    await page.getByTestId("workspace-todos-toggle").filter({ visible: true }).click();
    await expect(page.getByTestId("workspace-todos-new-title")).toHaveValue(
      "Draft survives workspace changes",
    );
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: second.workspaceId,
    });
    await expect(panel).toBeHidden();
    await page.getByTestId("workspace-todos-toggle").filter({ visible: true }).click();
    await expect(page.getByTestId("workspace-todos-counter").filter({ visible: true })).toHaveText(
      "0/0",
    );
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: first.workspaceId,
    });
    await expect(
      page.getByTestId("workspace-todos-new-title").filter({ visible: true }),
    ).toHaveValue("Draft survives workspace changes");
    const box = await panel.boundingBox();
    const header = await page
      .getByTestId("workspace-header-title")
      .filter({ visible: true })
      .boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(header!.x);
    expect(box!.height).toBeGreaterThan(900);
    expect(box!.y).toBeLessThan(50);
    await page.screenshot({ path: testInfo.outputPath("workspace-todos-wide.png") });
    await page.reload();
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("workspace-todo-milestone-Verification")).toBeVisible();
    await page.setViewportSize({ width: 1000, height: 650 });
    await expect
      .poll(async () => {
        const a = await panel.boundingBox();
        return Boolean(a && a.x >= 0 && a.y >= 0 && a.x + a.width <= 1000 && a.y + a.height <= 651);
      })
      .toBe(true);
    await page.getByTestId(`workspace-todo-menu-${secondId}`).click();
    await page.getByRole("menuitem", { name: "Delete task", exact: true }).click();
    await expect(page.getByTestId("workspace-todos-counter").filter({ visible: true })).toHaveText(
      "1/1",
    );
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test("compact To-do sheet and revision conflict preserve the draft", async ({ page }, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "todo-compact-" });
  try {
    await gotoAppShell(page);
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: workspace.workspaceId,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("workspace-todos-toggle").filter({ visible: true }).click();
    await expect(page.getByTestId("workspace-todos-sheet").filter({ visible: true })).toBeVisible();
    await addTask(page, "Implement shared tasks", "A compact sheet uses the same project list.");
    const list = (await workspace.client.getWorkspaceTodos(workspace.workspaceId)).list;
    const id = list.tasks[0]!.id;
    await page.getByTestId(`workspace-todo-notes-toggle-${id}`).click();
    await page.getByTestId(`workspace-todo-title-${id}`).fill("My unsaved title");
    await workspace.client.mutateWorkspaceTodos(workspace.workspaceId, list.revision, {
      operation: "update",
      id,
      status: "in_progress",
    });
    await expect(page.getByTestId(`workspace-todo-status-${id}`)).toHaveText("In progress");
    await page.getByTestId(`workspace-todo-save-${id}`).click();
    await expect(page.getByTestId("workspace-todos-error").filter({ visible: true })).toContainText(
      "revision conflict",
    );
    await expect(page.getByTestId(`workspace-todo-title-${id}`)).toHaveValue("My unsaved title");
    await page.getByTestId("workspace-todos-retry").filter({ visible: true }).click();
    await expect(page.getByTestId("workspace-todos-error").filter({ visible: true })).toBeHidden();
    await page.getByTestId(`workspace-todo-notes-toggle-${id}`).click();
    await expect(page.getByTestId(`workspace-todo-notes-${id}`)).toHaveValue(
      "A compact sheet uses the same project list.",
    );
    await page.screenshot({ path: testInfo.outputPath("workspace-todos-compact.png") });
  } finally {
    await workspace.cleanup();
  }
});

test("old hosts explain the To-do update requirement at entry", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "todo-old-host-" });
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message !== "string") {
        socket.send(message);
        return;
      }
      const parsed = JSON.parse(message);
      const session = parsed.message ?? parsed;
      if (session.type === "status" && session.payload?.status === "server_info")
        delete session.payload.features.workspaceTodoMilestones;
      socket.send(JSON.stringify(parsed));
    });
  });
  try {
    await gotoAppShell(page);
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: workspace.workspaceId,
    });
    await page.getByTestId("workspace-todos-toggle").filter({ visible: true }).click();
    await expect(
      page.getByTestId("workspace-todos-update-host").filter({ visible: true }),
    ).toContainText("Update this host");
  } finally {
    await workspace.cleanup();
  }
});

test("To-do observations resynchronize on reconnect without discarding text drafts", async ({
  page,
}) => {
  const gate = await installDaemonWebSocketGate(page);
  const workspace = await seedWorkspace({ repoPrefix: "todo-reconnect-" });
  try {
    await gotoAppShell(page);
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: workspace.workspaceId,
    });
    await page.getByTestId("workspace-todos-toggle").filter({ visible: true }).click();
    await addTask(page, "Reconnect the list");
    const list = (await workspace.client.getWorkspaceTodos(workspace.workspaceId)).list;
    const id = list.tasks[0]!.id;
    await page.getByTestId(`workspace-todo-notes-toggle-${id}`).click();
    await page.getByTestId(`workspace-todo-title-${id}`).fill("Keep this local draft");
    await gate.drop();
    await gate.waitForBlockedConnection();
    await page.getByTestId(`workspace-todo-save-${id}`).click();
    await expect(page.getByTestId("workspace-todos-error")).toBeVisible();
    await workspace.client.mutateWorkspaceTodos(workspace.workspaceId, list.revision, {
      operation: "update",
      id,
      status: "done",
    });
    await expect(page.getByTestId(`workspace-todo-title-${id}`)).toHaveValue(
      "Keep this local draft",
    );
    gate.restore();
    await expect(page.getByTestId(`workspace-todo-status-${id}`)).toHaveText("Done", {
      timeout: 30_000,
    });
    await expect(page.getByTestId(`workspace-todo-title-${id}`)).toHaveValue(
      "Keep this local draft",
    );
  } finally {
    gate.restore();
    await workspace.cleanup();
  }
});

test("Jalons shows long titles in three real milestones without truncation", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "jalons-preview-", git: false });
  try {
    const initial = await workspace.client.mutateWorkspaceTodos(workspace.workspaceId, 0, {
      operation: "initialize",
      tasks: [
        {
          title: "Clarifier les interactions et les couleurs de l’interface",
          notes: "Conserver les raccourcis clavier et les interactions tactiles.",
          milestone: "Interactions & interface",
        },
        {
          title: "Activer les profils de handoff dans la fenêtre de validation des plans",
          notes:
            "Vérifier la version active de l’interface et conserver les conversations ouvertes.",
          milestone: "Handoff & version locale",
        },
        {
          title: "Fiabiliser la publication et l’activation des versions locales",
          notes: "Comparer la version publiée, la version installée et celle réellement utilisée.",
          milestone: "Handoff & version locale",
        },
        {
          title: "Intégrer les réponses interactives et l’approfondissement dans les conversations",
          notes: "Vérifier le rendu sur desktop et sur petit écran.",
          milestone: "Conversations interactives",
        },
      ],
    });
    let revision = initial.revision;
    for (const [index, task] of initial.tasks.entries()) {
      const list = await workspace.client.mutateWorkspaceTodos(workspace.workspaceId, revision, {
        operation: "update",
        id: task.id,
        status: index === 0 ? "done" : "in_progress",
      });
      revision = list.revision;
    }
    await page.setViewportSize({ width: 1440, height: 1050 });
    await gotoAppShell(page);
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: workspace.workspaceId,
    });
    await page.getByTestId("workspace-todos-toggle").filter({ visible: true }).click();
    await expect(
      page.getByTestId("workspace-todo-milestone-Conversations interactives"),
    ).toBeVisible();
    const title = page.getByTestId(`workspace-todo-label-${initial.tasks[3]!.id}`);
    await expect(title).toHaveText(initial.tasks[3]!.title);
    expect(
      await title.evaluate(
        (element) =>
          element.scrollWidth <= element.clientWidth &&
          element.scrollHeight <= element.clientHeight,
      ),
    ).toBe(true);
    await page.mouse.move(1350, 900);
    await page.getByTestId("workspace-header-title").filter({ visible: true }).click();
    await expect(page.getByTestId("workspace-hover-card")).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("jalons-desktop.png") });
  } finally {
    await workspace.cleanup();
  }
});
