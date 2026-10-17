import {
  composerLocator,
  enterComposerFullscreen,
  exitComposerFullscreen,
  resizeComposerViewport,
} from "../support/helpers/composer";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  delayBrowserWorkspaceCreatedResponse,
  expectNewWorkspaceDraft,
  fillNewWorkspaceDraft,
  openGlobalNewWorkspaceComposer,
  openNewWorkspaceComposer,
} from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const DRAFT = `Please investigate the workspace startup failure.

Trace the request from the app through the daemon, preserve the existing behavior, and explain the root cause before making changes.`;

test.describe("New workspace composer draft", () => {
  test.describe.configure({ timeout: 240_000 });

  test("does not restore a submitted draft after deferred publication", async ({ page }) => {
    const project = await seedWorkspace({ repoPrefix: "new-workspace-submitted-draft-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: project.projectKey,
        projectDisplayName: project.projectDisplayName,
      });

      const composer = page.getByRole("textbox", { name: "Message agent..." });
      const createButton = page.getByTestId("workspace-create-submit");
      await expect(composer).toBeEditable({ timeout: 30_000 });
      await expect(createButton).toBeEnabled({ timeout: 30_000 });

      await composer.evaluate((element, draft) => {
        if (!(element instanceof HTMLTextAreaElement)) {
          throw new Error("Composer input is not a textarea");
        }
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        if (!valueSetter) throw new Error("Textarea value setter is unavailable");
        valueSetter.call(element, draft);
        element.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: draft,
            inputType: "insertText",
          }),
        );
        const button = document.querySelector('[data-testid="workspace-create-submit"]');
        if (!(button instanceof HTMLElement)) {
          throw new Error("Create button is unavailable");
        }
        button.click();
      }, DRAFT);

      await page.waitForURL((url) => url.pathname.includes("/workspace/"), { timeout: 30_000 });
      await openGlobalNewWorkspaceComposer(page);
      await expectNewWorkspaceDraft(page, "");
    } finally {
      await project.cleanup();
    }
  });
});

test("fullscreen creation returns inline and keeps submission locked when reopened", async ({
  page,
}) => {
  const project = await seedWorkspace({ repoPrefix: "fullscreen-submit-pending-" });
  const delay = await delayBrowserWorkspaceCreatedResponse(page);
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, project);
    await resizeComposerViewport(page, "portrait");
    await fillNewWorkspaceDraft(page, DRAFT);
    await enterComposerFullscreen(page);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await delay.waitForCreateRequest();

    await test.step("submission returns inline with the original draft and spinner", async () => {
      await expect(page.getByTestId("composer-fullscreen")).toHaveCount(0);
      await expect(composerLocator(page)).toHaveValue(DRAFT);
      await expect(composerLocator(page)).not.toBeEditable();
      await expect(page.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
      await expect(page.getByRole("progressbar")).toBeVisible();
    });
    await test.step("fullscreen can reopen while pending without unlocking or duplicating submission", async () => {
      await enterComposerFullscreen(page);
      await expect(page.getByTestId("composer-fullscreen")).toBeVisible();
      await expect(composerLocator(page)).toHaveValue(DRAFT);
      await expect(composerLocator(page)).not.toBeEditable();
      await expect(page.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
      await expect(page.getByRole("progressbar")).toBeVisible();
      await exitComposerFullscreen(page);
    });
    delay.release();
    await page.waitForURL((url) => url.pathname.includes("/workspace/"));
    await expect(composerLocator(page)).toHaveValue("");
    await expect(composerLocator(page)).toBeEditable();
    expect(delay.agentRequests).toHaveLength(1);
  } finally {
    delay.release();
    await project.cleanup();
  }
});
