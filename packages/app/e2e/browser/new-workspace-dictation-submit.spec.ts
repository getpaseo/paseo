import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  installDictationWsHarness,
  installSyntheticMicrophone,
  sendSessionMessage,
} from "../support/helpers/dictation-ws";
import {
  openNewWorkspaceComposer,
  selectWorkspaceIsolation,
} from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  composerLocator,
  expectComposerVisible,
  fillComposerDraft,
  enterComposerFullscreen,
  resizeComposerViewport,
  expectComposerFullscreenControls,
} from "../support/helpers/composer";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const TRANSCRIPT = "Keep this spoken prompt visible while creating the workspace";
const CREATE_FAILURE = "Synthetic workspace creation failure";

async function installDictationFailureHarness(page: Page) {
  let resolveCreateRequest!: () => void;
  const createRequest = new Promise<void>((resolve) => {
    resolveCreateRequest = resolve;
  });
  let failCreate: (() => void) | null = null;

  const dictation = await installDictationWsHarness(page, {
    transcript: TRANSCRIPT,
    interceptClientMessage: (request, ws) => {
      if (request.type !== "workspace.create.request" || typeof request.requestId !== "string") {
        return false;
      }
      const requestId = request.requestId;
      failCreate = () => {
        sendSessionMessage(ws, {
          type: "workspace.create.response",
          payload: {
            requestId,
            workspace: null,
            setupTerminalId: null,
            error: CREATE_FAILURE,
          },
        });
      };
      resolveCreateRequest();
      return true;
    },
  });
  const audioChunk = dictation.nextChunk();

  return {
    waitForAudio: () => audioChunk,
    waitForCreateRequest: () => createRequest,
    failWorkspaceCreation: () => {
      if (!failCreate) {
        throw new Error("Workspace creation request has not been received");
      }
      failCreate();
    },
  };
}

async function dictateAndSend(page: Page, waitForAudio: () => Promise<void>): Promise<void> {
  await page.getByRole("button", { name: "Start dictation" }).click();
  await waitForAudio();
  await page.getByRole("button", { name: "Insert transcription and send" }).click();
}

test.describe("New Workspace dictation submit", () => {
  test.describe.configure({ timeout: 240_000 });

  test("keeps the spoken prompt visible while pending and after failure", async ({ page }) => {
    const seeded = await seedWorkspace({ repoPrefix: "dictation-submit-" });
    await installSyntheticMicrophone(page);
    const harness = await installDictationFailureHarness(page);

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: seeded.projectKey,
        projectDisplayName: seeded.projectDisplayName,
      });
      await selectWorkspaceIsolation(page, "local");

      await dictateAndSend(page, harness.waitForAudio);
      await harness.waitForCreateRequest();

      const composer = page.getByRole("textbox", { name: "Message agent..." });
      await expect(composer).toHaveValue(TRANSCRIPT);
      await expect(composer).not.toBeEditable();

      harness.failWorkspaceCreation();

      await expect(composer).toBeEditable();
      await expect(composer).toHaveValue(TRANSCRIPT);
      await expect(page.getByText(CREATE_FAILURE).first()).toBeVisible();
    } finally {
      await seeded.cleanup();
    }
  });
});

async function startDictationWithShortcut(page: Page): Promise<void> {
  await composerLocator(page).press("Control+d");
}

test("dictation shortcut leaves retained fullscreen and exposes recording controls", async ({
  page,
}) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "fullscreen-dictation-",
    title: "Fullscreen dictation shortcut",
  });
  await installSyntheticMicrophone(page);
  const harness = await installDictationFailureHarness(page);
  const draft = "First line\nSecond line\nThird line";
  try {
    await resizeComposerViewport(page, "portrait");
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    await fillComposerDraft(page, draft);
    await enterComposerFullscreen(page);
    await resizeComposerViewport(page, "landscape");
    await expectComposerFullscreenControls(page);
    await startDictationWithShortcut(page);
    await harness.waitForAudio();
    await expect(page.getByRole("button", { name: "Exit fullscreen", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel dictation", exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Insert transcription", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Insert transcription and send", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel dictation", exact: true }).click();
    await expect(composerLocator(page)).toBeEditable();
    await expect(composerLocator(page)).toHaveValue(draft);
    await resizeComposerViewport(page, "portrait");
    await enterComposerFullscreen(page);
    await resizeComposerViewport(page, "landscape");
    await composerLocator(page).press("Control+Shift+d");
    await expect(page.getByRole("button", { name: "Exit fullscreen", exact: true })).toHaveCount(0);
    await expect(
      page.getByText("Realtime voice is disabled in this test.", { exact: true }),
    ).toBeVisible();
    await expect(composerLocator(page)).toHaveValue(draft);
  } finally {
    await agent.cleanup();
  }
});
