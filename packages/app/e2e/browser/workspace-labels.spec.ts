import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openSettingsSection } from "../support/helpers/settings";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";

interface SessionEnvelope {
  type?: string;
  message?: { type?: string; requestId?: string };
}

async function readWorkspaceLabels(seeded: Awaited<ReturnType<typeof seedWorkspace>>) {
  const workspaces = await seeded.client.fetchWorkspaces();
  for (const workspace of workspaces.entries) {
    if (workspace.id === seeded.workspaceId) return workspace.labels?.slice().sort();
  }
  return undefined;
}

async function installWorkspaceLabelMutationFailure(page: import("@playwright/test").Page) {
  let failNextAssignment = false;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      const raw = typeof message === "string" ? message : message.toString("utf8");
      let envelope: SessionEnvelope | null = null;
      try {
        envelope = JSON.parse(raw) as SessionEnvelope;
      } catch {
        server.send(message);
        return;
      }
      const request = envelope?.type === "session" ? envelope.message : null;
      if (
        failNextAssignment &&
        request?.type === "workspace.label.assignment.set.request" &&
        request.requestId
      ) {
        failNextAssignment = false;
        browser.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "rpc_error",
              payload: {
                requestId: request.requestId,
                requestType: request.type,
                error: "Injected label mutation failure.",
                code: "handler_error",
              },
            },
          }),
        );
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => browser.send(message));
  });
  return {
    failNextAssignment() {
      failNextAssignment = true;
    },
  };
}

async function openWorkspaceLabels(page: import("@playwright/test").Page, workspaceId: string) {
  const serverId = getServerId();
  const row = page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();
  await page.getByTestId(`sidebar-workspace-kebab-${serverId}:${workspaceId}`).first().click();
  await page.getByTestId(`sidebar-workspace-menu-labels-${serverId}:${workspaceId}`).click();
  await expect(page.getByPlaceholder("Search labels")).toBeVisible();
}

async function openWorkspaceLabelsOnTouch(
  page: import("@playwright/test").Page,
  workspaceId: string,
) {
  const serverId = getServerId();
  const row = page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(`sidebar-workspace-kebab-${serverId}:${workspaceId}`).click();
  await page.getByTestId(`sidebar-workspace-menu-labels-${serverId}:${workspaceId}`).tap();
  await expect(page.getByPlaceholder("Search labels")).toBeVisible();
}

async function createLabel(
  page: import("@playwright/test").Page,
  input: { workspaceId: string; name: string; color: string },
) {
  await openWorkspaceLabels(page, input.workspaceId);
  await page.getByPlaceholder("Search labels").fill(input.name);
  await page.getByRole("button", { name: `Create new label: "${input.name}"` }).click();
  await page
    .getByRole("button", { name: `${input.color[0]?.toUpperCase()}${input.color.slice(1)}` })
    .click();
  await expect(page.getByPlaceholder("Search labels")).toBeHidden();
}

test.describe("Workspace labels", () => {
  test.describe.configure({ timeout: 180_000 });

  test("keeps label filters reachable when no workspaces match", async ({ page }) => {
    const seeded = await seedWorkspace({ repoPrefix: "workspace-labels-no-matches-" });
    try {
      await seeded.client.setWorkspaceLabel({
        workspaceId: seeded.workspaceId,
        label: { name: "Unused", color: "red" },
        assigned: true,
      });
      await seeded.client.setWorkspaceLabel({
        workspaceId: seeded.workspaceId,
        label: { name: "Unused", color: "red" },
        assigned: false,
      });
      await gotoAppShell(page);

      await page.getByTestId("sidebar-display-preferences-menu").click();
      await page.getByTestId("sidebar-display-label-filter").click();
      // Clear only exists once something is filtered, so the row has to be included first.
      await expect(page.getByTestId("sidebar-label-filter-clear")).toBeHidden();
      await page.getByTestId("sidebar-label-filter-option-Unused").click();

      await expect(page.getByText("No workspaces match", { exact: true })).toBeVisible();
      await expect(page.getByTestId("sidebar-project-empty-state")).toBeHidden();
      await expect(page.getByTestId("sidebar-display-preferences-menu")).toBeVisible();

      await page.getByTestId("sidebar-display-preferences-menu").click();
      await page.getByTestId("sidebar-display-label-filter").click();
      await page.getByTestId("sidebar-label-filter-clear").click();
      await expect(
        page.getByTestId(`sidebar-workspace-row-${getServerId()}:${seeded.workspaceId}`),
      ).toBeVisible();
    } finally {
      await seeded.cleanup();
    }
  });

  test("creates, multi-assigns, filters, groups, and renames against the daemon", async ({
    page,
  }) => {
    const seeded = await seedWorkspace({ repoPrefix: "workspace-labels-" });
    const unlabelled = await seedWorkspace({ repoPrefix: "workspace-labels-unlabelled-" });
    try {
      const mutationFailure = await installWorkspaceLabelMutationFailure(page);
      await gotoAppShell(page);
      await createLabel(page, { workspaceId: seeded.workspaceId, name: "Urgent", color: "red" });
      await createLabel(page, {
        workspaceId: seeded.workspaceId,
        name: "Frontend",
        color: "sky",
      });

      await test.step("checkbox toggles keep the picker open while row toggles close it", async () => {
        await openWorkspaceLabels(page, seeded.workspaceId);
        await page.getByRole("checkbox", { name: "Remove Urgent and keep labels open" }).click();
        await expect(page.getByPlaceholder("Search labels")).toBeVisible();
        await page.getByRole("checkbox", { name: "Remove Frontend and keep labels open" }).click();
        await expect(page.getByPlaceholder("Search labels")).toBeVisible();
        await page.getByRole("checkbox", { name: "Add Urgent and keep labels open" }).click();
        await expect(page.getByPlaceholder("Search labels")).toBeVisible();
        await page.getByRole("checkbox", { name: "Add Frontend and keep labels open" }).click();
        await expect(page.getByPlaceholder("Search labels")).toBeVisible();
        await page.keyboard.press("Escape");

        await openWorkspaceLabels(page, seeded.workspaceId);
        await expect(
          page.getByRole("checkbox", {
            name: "Remove Urgent and keep labels open",
          }),
        ).toBeVisible();
        await expect(
          page.getByRole("checkbox", {
            name: "Remove Frontend and keep labels open",
          }),
        ).toBeVisible();
        await page.getByRole("menuitem", { name: "Urgent" }).click();
        await expect(page.getByPlaceholder("Search labels")).toBeHidden();
        await openWorkspaceLabels(page, seeded.workspaceId);
        await page.getByRole("menuitem", { name: "Urgent" }).click();
        await expect(page.getByPlaceholder("Search labels")).toBeHidden();

        await expect.poll(readWorkspaceLabels.bind(null, seeded)).toEqual(["Frontend", "Urgent"]);
      });

      await test.step("one label row cycles include, exclude, off and composes with grouping", async () => {
        const labelledRow = page.getByTestId(
          `sidebar-workspace-row-${getServerId()}:${seeded.workspaceId}`,
        );
        const unlabelledRow = page.getByTestId(
          `sidebar-workspace-row-${getServerId()}:${unlabelled.workspaceId}`,
        );
        await page.getByTestId("sidebar-display-preferences-menu").click();
        await page.getByTestId("sidebar-display-label-filter").click();

        const urgent = page.getByTestId("sidebar-label-filter-option-Urgent");
        await urgent.click();
        await expect(labelledRow).toBeVisible();
        await expect(unlabelledRow).toBeHidden();

        await urgent.click();
        await expect(labelledRow).toBeHidden();
        await expect(unlabelledRow).toBeVisible();

        await urgent.click();
        await page.getByTestId("sidebar-label-filter-option-unlabelled").click();
        await expect(labelledRow).toBeHidden();
        await expect(unlabelledRow).toBeVisible();

        // Two included labels are what the match toggle is for, and only then.
        await expect(page.getByTestId("sidebar-label-filter-match-any")).toBeHidden();
        await urgent.click();
        await expect(page.getByTestId("sidebar-label-filter-match-any")).toBeVisible();
        await page.getByTestId("sidebar-label-filter-match-all").click();
        // Labelled and unlabelled at once is unsatisfiable, which empties the sidebar and takes
        // the open menu down with it — so the way back is through the trigger, not the page.
        await expect(labelledRow).toBeHidden();
        await expect(unlabelledRow).toBeHidden();

        await page.getByTestId("sidebar-display-preferences-menu").click();
        await page.getByTestId("sidebar-display-label-filter").click();
        await page.getByTestId("sidebar-label-filter-clear").click();
        await expect(page.getByTestId("sidebar-label-filter-clear")).toBeHidden();
        await page.keyboard.press("Escape");
        await page.getByTestId("sidebar-display-preferences-menu").click();
        await page.getByTestId("sidebar-display-grouping").click();
        await page.getByTestId("sidebar-grouping-label").click();
        await expect(page.getByTestId("sidebar-workspace-group-label:urgent")).toBeVisible();
        await expect(page.getByTestId("sidebar-workspace-group-label:urgent")).toHaveAttribute(
          "aria-label",
          "Urgent group",
        );
        await expect(page.getByTestId("sidebar-workspace-group-label:frontend")).toBeVisible();
        await expect(
          page.getByTestId("sidebar-workspace-group-synthetic:unlabelled"),
        ).toBeVisible();
      });

      await test.step("management targets the selected host and preserves assignments on rename", async () => {
        await page.getByTestId("sidebar-display-preferences-menu").click();
        await page.getByTestId("sidebar-display-label-filter").click();
        await page.getByTestId("sidebar-label-manage").click();
        await expect(page.getByText("Manage labels", { exact: true })).toBeVisible();
        await page.getByTestId("workspace-label-manager-label-Urgent").click();
        // Phase 1's swatch names a colour by itself; the old "{{color}} label color" string is
        // no longer rendered anywhere.
        await expect(page.getByRole("radio", { name: "Red" })).toBeChecked();
        await expect(page.getByRole("radio", { name: "Sky" })).not.toBeChecked();
        await page.getByTestId("workspace-label-manager-name").fill("Priority");
        await page.getByRole("button", { name: "Rename" }).click();
        await expect(page.getByTestId("workspace-label-manager-label-Priority")).toBeVisible();
      });

      await test.step("rendered creation failure stays open and retries after reconnect", async () => {
        await page.keyboard.press("Escape");
        await openWorkspaceLabels(page, seeded.workspaceId);
        await page.getByPlaceholder("Search labels").fill("Retry");
        await page.getByRole("button", { name: 'Create new label: "Retry"' }).click();
        mutationFailure.failNextAssignment();
        await page.getByRole("button", { name: "Red" }).click();
        await expect(page.getByTestId("workspace-label-picker-error")).toContainText(
          "Injected label mutation failure.",
        );
        await expect(page.getByPlaceholder("Search labels")).toBeVisible();

        await page.getByRole("button", { name: "Red" }).click();
        await expect(page.getByPlaceholder("Search labels")).toBeHidden();
        await openWorkspaceLabels(page, seeded.workspaceId);
        await expect(
          page.getByRole("checkbox", { name: "Remove Retry and keep labels open" }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
      });

      await test.step("active locale updates label group headings and accessibility", async () => {
        await openSettings(page);
        await openSettingsSection(page, "general");
        await page.getByRole("button", { name: "System", exact: true }).click();
        await page.getByRole("button", { name: "Español - Spanish", exact: true }).click();
        await page.goBack();
        await expect(
          page.getByTestId("sidebar-workspace-group-synthetic:unlabelled"),
        ).toHaveAttribute("aria-label", "Grupo Sin etiqueta");

        await openSettings(page);
        await openSettingsSection(page, "general");
        await page.getByRole("button", { name: /^Español/ }).click();
        await page.getByRole("button", { name: /^English/ }).click();
        await page.goBack();
      });
    } finally {
      await unlabelled.cleanup();
      await seeded.cleanup();
    }
  });

  test.describe("touch picker controls", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test("checkbox stays open while the row body closes", async ({ page }) => {
      const seeded = await seedWorkspace({ repoPrefix: "workspace-labels-touch-" });
      try {
        await seeded.client.setWorkspaceLabel({
          workspaceId: seeded.workspaceId,
          label: { name: "Touch", color: "red" },
          assigned: true,
        });
        await gotoAppShell(page);
        await page.getByRole("button", { name: "Open menu", exact: true }).click();
        await waitForSidebarHydration(page);
        await openWorkspaceLabelsOnTouch(page, seeded.workspaceId);

        const checkbox = page.getByRole("checkbox", {
          name: "Remove Touch and keep labels open",
        });
        const touchTarget = await checkbox.boundingBox();
        expect(touchTarget?.width).toBeGreaterThanOrEqual(44);
        expect(touchTarget?.height).toBeGreaterThanOrEqual(44);
        await checkbox.tap();
        await expect(page.getByPlaceholder("Search labels")).toBeVisible();
        await page.getByRole("menuitem", { name: "Touch" }).tap();
        await expect(page.getByPlaceholder("Search labels")).toBeHidden();
      } finally {
        await seeded.cleanup();
      }
    });
  });
});
