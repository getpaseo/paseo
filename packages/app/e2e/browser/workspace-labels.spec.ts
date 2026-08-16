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
  let failNextUpdate = false;
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
      const failing =
        (failNextAssignment && request?.type === "workspace.label.assignment.set.request") ||
        (failNextUpdate && request?.type === "workspace.label.update.request");
      if (failing && request?.type && request.requestId) {
        failNextAssignment = false;
        failNextUpdate = false;
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
    failNextUpdate() {
      failNextUpdate = true;
    },
  };
}

function labelRow(page: import("@playwright/test").Page, name: string) {
  return page.getByTestId(`workspace-label-picker-row-${name}`);
}

async function box(locator: import("@playwright/test").Locator) {
  const measured = await locator.boundingBox();
  if (!measured) throw new Error("expected a visible element to measure");
  return measured;
}

async function size(locator: import("@playwright/test").Locator) {
  await settled(locator);
  const { width, height } = await box(locator);
  return { width, height };
}

/**
 * Waits until an element stops moving.
 *
 * The flyout scales in and the sidebar behind it re-lays out as the filter changes, so a rail
 * measured mid-animation is not a rail — and a measurement built from two `boundingBox()` calls
 * would take its two halves from two different frames.
 */
async function settled(locator: import("@playwright/test").Locator) {
  let previous = "";
  await expect
    .poll(async () => {
      const current = JSON.stringify(await box(locator));
      const stable = current === previous;
      previous = current;
      return stable;
    })
    .toBe(true);
}

async function expectAssigned(
  page: import("@playwright/test").Page,
  name: string,
  assigned: boolean,
) {
  await expect(labelRow(page, name)).toHaveAttribute("aria-checked", String(assigned));
}

async function openWorkspaceLabels(page: import("@playwright/test").Page, workspaceId: string) {
  const serverId = getServerId();
  const row = page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();
  await page.getByTestId(`sidebar-workspace-kebab-${serverId}:${workspaceId}`).first().click();
  await page.getByTestId(`sidebar-workspace-menu-labels-${serverId}:${workspaceId}`).click();
  await expect(page.getByTestId("workspace-label-picker-create")).toBeVisible();
}

/**
 * Creating is its own page: the list is replaced by a name field and the swatches, and one row
 * commits. Picking a colour must not create anything on its own.
 */
async function createLabel(
  page: import("@playwright/test").Page,
  input: { workspaceId: string; name: string; color: string },
) {
  await openWorkspaceLabels(page, input.workspaceId);
  await page.getByTestId("workspace-label-picker-create").click();
  await expect(page.getByTestId("workspace-label-picker-create-name")).toBeVisible();
  await page.getByTestId("workspace-label-picker-create-name").fill(input.name);
  await page.getByTestId(`workspace-label-swatch-${input.color}`).click();
  await expect(page.getByTestId(`workspace-label-picker-row-${input.name}`)).toBeHidden();
  await page.getByTestId("workspace-label-picker-create-submit").click();
  await expectAssigned(page, input.name, true);
  await page.keyboard.press("Escape");
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
      // Clear only exists once something is filtered, so the row has to be selected first.
      await expect(page.getByTestId("sidebar-label-filter-clear")).toBeHidden();
      await page.getByTestId("sidebar-label-filter-option-Unused").click();

      await expect(page.getByText("No workspaces match", { exact: true })).toBeVisible();
      await expect(page.getByTestId("sidebar-project-empty-state")).toBeHidden();
      await expect(page.getByTestId("sidebar-display-preferences-menu")).toBeVisible();

      // Emptying the sidebar swaps the list's body and nothing above it, so the page the filter
      // was set on is still up over the empty state and clearing it is one press away.
      await expect(page.getByTestId("sidebar-label-filter-clear")).toBeVisible();
      await page.getByTestId("sidebar-label-filter-clear").click();
      await expect(
        page.getByTestId(`sidebar-workspace-row-${getServerId()}:${seeded.workspaceId}`),
      ).toBeVisible();
    } finally {
      await seeded.cleanup();
    }
  });

  test("creates, multi-assigns, filters, groups, and edits against the daemon", async ({
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

      await test.step("every press toggles and the picker stays open", async () => {
        await openWorkspaceLabels(page, seeded.workspaceId);
        await labelRow(page, "Urgent").click();
        await expectAssigned(page, "Urgent", false);
        await labelRow(page, "Frontend").click();
        await expectAssigned(page, "Frontend", false);
        await labelRow(page, "Urgent").click();
        await labelRow(page, "Frontend").click();
        await expectAssigned(page, "Urgent", true);
        await expectAssigned(page, "Frontend", true);
        // Four toggles in, the page it started on is still the page it is on.
        await expect(page.getByTestId("workspace-label-picker-create")).toBeVisible();
        await page.keyboard.press("Escape");

        await expect.poll(readWorkspaceLabels.bind(null, seeded)).toEqual(["Frontend", "Urgent"]);
      });

      await test.step("a rejected assignment leaves the row alone and says why", async () => {
        await openWorkspaceLabels(page, seeded.workspaceId);
        mutationFailure.failNextAssignment();
        await labelRow(page, "Urgent").click();
        await expect(page.getByTestId("workspace-label-picker-error")).toContainText(
          "Injected label mutation failure.",
        );
        await expectAssigned(page, "Urgent", true);
        await page.keyboard.press("Escape");
      });

      await test.step("a label row filters on one press and clears on the next", async () => {
        const labelledRow = page.getByTestId(
          `sidebar-workspace-row-${getServerId()}:${seeded.workspaceId}`,
        );
        const unlabelledRow = page.getByTestId(
          `sidebar-workspace-row-${getServerId()}:${unlabelled.workspaceId}`,
        );
        await page.getByTestId("sidebar-display-preferences-menu").click();
        await page.getByTestId("sidebar-display-label-filter").click();

        const urgent = page.getByTestId("sidebar-label-filter-option-Urgent");
        const frontend = page.getByTestId("sidebar-label-filter-option-Frontend");
        const unlabelledLabel = page.getByTestId("sidebar-label-filter-option-unlabelled");
        // A row is one control, so the only thing on it that could move is the check the engine
        // draws — measured before anything is filtered, and again once a row carries one.
        const atRest = await size(urgent);

        // One press in, one press out, and the row is the whole target either way.
        await urgent.click();
        await expect(urgent).toHaveAttribute("aria-checked", "true");
        await expect(labelledRow).toBeVisible();
        await expect(unlabelledRow).toBeHidden();
        expect(await size(urgent)).toEqual(atRest);

        await urgent.click();
        await expect(urgent).toHaveAttribute("aria-checked", "false");
        await expect(labelledRow).toBeVisible();
        await expect(unlabelledRow).toBeVisible();
        expect(await size(urgent)).toEqual(atRest);

        // Selecting every label there is empties nothing; selecting one that nothing carries
        // together with Unlabelled under "all" is what empties the sidebar, below.
        await unlabelledLabel.click();
        await expect(labelledRow).toBeHidden();
        await expect(unlabelledRow).toBeVisible();

        // Two selected labels are what the match toggle is for, and only then.
        await expect(page.getByTestId("sidebar-label-filter-match-any")).toBeHidden();
        await urgent.click();
        await expect(page.getByTestId("sidebar-label-filter-match-any")).toBeVisible();
        await expect(labelledRow).toBeVisible();
        await expect(unlabelledRow).toBeVisible();

        // Labelled and unlabelled at once is unsatisfiable, so this empties the sidebar. That
        // swaps the list's body and nothing above it, so the header the flyout is anchored to
        // survives and the page stays up — this is the transition that used to close the menu.
        await page.getByTestId("sidebar-label-filter-match-all").click();
        await expect(labelledRow).toBeHidden();
        await expect(unlabelledRow).toBeHidden();
        await expect(page.getByTestId("sidebar-label-filter-empty-state")).toBeVisible();
        await expect(page.getByTestId("sidebar-label-filter-clear")).toBeVisible();

        // And back out of it from that same still-open page, which is the swap in reverse.
        await page.getByTestId("sidebar-label-filter-clear").click();
        await expect(page.getByTestId("sidebar-label-filter-empty-state")).toBeHidden();
        await expect(page.getByTestId("sidebar-label-filter-clear")).toBeHidden();
        await expect(page.getByTestId("sidebar-label-filter-match-any")).toBeHidden();
        await expect(labelledRow).toBeVisible();
        await expect(unlabelledRow).toBeVisible();
        await expect(urgent).toHaveAttribute("aria-checked", "false");
        await expect(frontend).toHaveAttribute("aria-checked", "false");
        await expect(unlabelledLabel).toHaveAttribute("aria-checked", "false");

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

      await test.step("editing a label is one operation and preserves its assignments", async () => {
        await page.getByTestId("sidebar-display-preferences-menu").click();
        await page.getByTestId("sidebar-display-label-filter").click();
        await page.getByTestId("sidebar-label-manage").click();
        await expect(page.getByText("Manage labels", { exact: true })).toBeVisible();

        await page.getByTestId("workspace-label-manager-search").fill("urg");
        await expect(page.getByTestId("workspace-label-manager-label-Frontend")).toBeHidden();
        await page.getByTestId("workspace-label-manager-search").fill("");
        await expect(page.getByTestId("workspace-label-manager-label-Frontend")).toBeVisible();

        // A row is a label, not a button that swaps the surface — the pencil opens the edit, and
        // it is only reachable once the row is hovered, the way it is only visible then.
        await page.getByTestId("workspace-label-manager-label-Urgent").hover();
        await page.getByTestId("workspace-label-manager-edit-Urgent").click();
        // Phase 1's swatch names a colour by itself; the old "{{color}} label color" string is
        // no longer rendered anywhere.
        await expect(page.getByRole("radio", { name: "Red" })).toBeChecked();
        await expect(page.getByRole("radio", { name: "Sky" })).not.toBeChecked();

        await page.getByTestId("workspace-label-manager-name").fill("Priority");
        await page.getByRole("radio", { name: "Amber" }).click();
        // Picking a colour picks a colour: nothing has left for the host yet.
        await expect(page.getByTestId("workspace-label-manager-save")).toBeVisible();

        mutationFailure.failNextUpdate();
        await page.getByTestId("workspace-label-manager-save").click();
        await expect(page.getByTestId("workspace-label-manager-error")).toContainText(
          "Injected label mutation failure.",
        );
        // Nothing half-applied: the view is still open on the draft exactly as typed.
        await expect(page.getByTestId("workspace-label-manager-name")).toHaveValue("Priority");
        await expect(page.getByRole("radio", { name: "Amber" })).toBeChecked();

        await page.getByTestId("workspace-label-manager-save").click();
        await expect(page.getByTestId("workspace-label-manager-label-Priority")).toBeVisible();
        await expect(page.getByTestId("workspace-label-manager-label-Urgent")).toBeHidden();
        await expect.poll(readWorkspaceLabels.bind(null, seeded)).toEqual(["Frontend", "Priority"]);
      });

      await test.step("a rejected creation keeps the draft and retries in place", async () => {
        await page.keyboard.press("Escape");
        await openWorkspaceLabels(page, seeded.workspaceId);
        await page.getByTestId("workspace-label-picker-create").click();
        await page.getByTestId("workspace-label-picker-create-name").fill("Retry");
        mutationFailure.failNextAssignment();
        await page.getByTestId("workspace-label-picker-create-submit").click();
        await expect(page.getByTestId("workspace-label-picker-error")).toContainText(
          "Injected label mutation failure.",
        );
        await expect(page.getByTestId("workspace-label-picker-create-name")).toHaveValue("Retry");

        await page.getByTestId("workspace-label-picker-create-submit").click();
        await expectAssigned(page, "Retry", true);
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

  test.describe("compact picker", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test("toggles in place and pushes the create page over the list", async ({ page }) => {
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

        const serverId = getServerId();
        await page.getByTestId(`sidebar-workspace-kebab-${serverId}:${seeded.workspaceId}`).click();
        await page
          .getByTestId(`sidebar-workspace-menu-labels-${serverId}:${seeded.workspaceId}`)
          .tap();
        await expectAssigned(page, "Touch", true);

        await labelRow(page, "Touch").tap();
        await expectAssigned(page, "Touch", false);
        await expect(page.getByTestId("workspace-label-picker-create")).toBeVisible();

        // The pushed page replaces the list rather than unfolding under it.
        await page.getByTestId("workspace-label-picker-create").tap();
        await expect(page.getByTestId("workspace-label-picker-create-name")).toBeVisible();
        await expect(labelRow(page, "Touch")).toBeHidden();
        await page.getByTestId("workspace-label-picker-create-name").fill("Handheld");
        await page.getByTestId("workspace-label-swatch-emerald").tap();
        await page.getByTestId("workspace-label-picker-create-submit").tap();

        await expectAssigned(page, "Handheld", true);
        await expectAssigned(page, "Touch", false);
      } finally {
        await seeded.cleanup();
      }
    });
  });
});
