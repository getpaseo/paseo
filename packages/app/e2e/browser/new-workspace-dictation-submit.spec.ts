import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
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
import {
  seedTerminalProfiles,
  selectLaunchOption,
  terminalPromptInput,
} from "../support/helpers/new-workspace-launch";

test.use({ channel: "chromium", launchOptions: { args: ["--use-fake-device-for-media-stream"] } });

type WebSocketMessage = string | Buffer;

const TRANSCRIPT = "Keep this spoken prompt visible while creating the workspace";
const CREATE_FAILURE = "Synthetic workspace creation failure";

function parseEnvelope(message: WebSocketMessage): {
  type?: unknown;
  message?: Record<string, unknown>;
} | null {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    return JSON.parse(raw) as { type?: unknown; message?: Record<string, unknown> };
  } catch {
    return null;
  }
}

function sessionMessage(message: WebSocketMessage): Record<string, unknown> | null {
  const envelope = parseEnvelope(message);
  return envelope?.type === "session" && envelope.message ? envelope.message : null;
}

function sendSessionMessage(
  ws: { send(message: string): void },
  message: Record<string, unknown>,
): void {
  ws.send(JSON.stringify({ type: "session", message }));
}

function enableDictationCapability(message: WebSocketMessage): WebSocketMessage {
  const envelope = parseEnvelope(message);
  const payload = envelope?.message?.payload;
  if (
    envelope?.message?.type !== "status" ||
    !payload ||
    typeof payload !== "object" ||
    (payload as { status?: unknown }).status !== "server_info"
  ) {
    return message;
  }

  (payload as Record<string, unknown>).capabilities = {
    voice: {
      dictation: { enabled: true, reason: "" },
      voice: { enabled: false, reason: "Realtime voice is disabled in this test." },
    },
  };
  return JSON.stringify(envelope);
}

async function installSyntheticMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const mediaDevices = navigator.mediaDevices;
    Object.defineProperty(mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        return destination.stream;
      },
    });
  });
}

async function installDictationFailureHarness(page: Page) {
  let resolveAudioChunk!: () => void;
  let resolveCreateRequest!: () => void;
  const audioChunk = new Promise<void>((resolve) => {
    resolveAudioChunk = resolve;
  });
  const createRequest = new Promise<void>((resolve) => {
    resolveCreateRequest = resolve;
  });
  let failCreate: (() => void) | null = null;

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      const request = sessionMessage(message);
      const type = request?.type;
      const dictationId = typeof request?.dictationId === "string" ? request.dictationId : null;

      if (type === "dictation_stream_start" && dictationId) {
        sendSessionMessage(ws, {
          type: "dictation_stream_ack",
          payload: { dictationId, ackSeq: -1 },
        });
        return;
      }
      if (type === "dictation_stream_chunk" && dictationId) {
        const seq = typeof request?.seq === "number" ? request.seq : 0;
        sendSessionMessage(ws, {
          type: "dictation_stream_ack",
          payload: { dictationId, ackSeq: seq },
        });
        resolveAudioChunk();
        return;
      }
      if (type === "dictation_stream_finish" && dictationId) {
        sendSessionMessage(ws, {
          type: "dictation_stream_finish_accepted",
          payload: { dictationId, timeoutMs: 5_000 },
        });
        sendSessionMessage(ws, {
          type: "dictation_stream_final",
          payload: { dictationId, text: TRANSCRIPT },
        });
        return;
      }
      if (request && type === "workspace.create.request" && typeof request.requestId === "string") {
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
        return;
      }

      server.send(message);
    });

    server.onMessage((message) => ws.send(enableDictationCapability(message)));
  });

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

async function controlMicrophonePermission(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  const origin = new URL(page.url()).origin;
  return async (setting: "denied" | "granted") => {
    await cdp.send("Browser.setPermission", {
      permission: { name: "microphone" },
      setting,
      origin,
      browserContextId: targetInfo.browserContextId,
    });
  };
}

function startDictationByMic(page: Page) {
  return page.getByRole("button", { name: "Start dictation", exact: true }).click();
}

function expectDictationPermissionError(page: Page) {
  return expect(page.getByTestId("message-input-root").getByRole("alert")).toHaveText(
    "Allow microphone access and try again.",
  );
}

test("keeps the draft and retries from the mic after access is restored", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "dictation-permission-",
    title: "Dictation permission",
  });
  const draft = "Keep my draft";
  await installDictationFailureHarness(page);
  try {
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    await fillComposerDraft(page, draft);

    const setMicrophonePermission = await controlMicrophonePermission(page);
    await setMicrophonePermission("denied");
    await startDictationByMic(page);
    await expectDictationPermissionError(page);
    await expect(composerLocator(page)).toHaveValue(draft);

    await setMicrophonePermission("granted");
    await startDictationByMic(page);
    await expect(page.getByRole("button", { name: "Cancel dictation", exact: true })).toBeVisible();
    await expect(page.getByText("Allow microphone access and try again.")).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel dictation", exact: true }).click();
    await expect(composerLocator(page)).toHaveValue(draft);
  } finally {
    await agent.cleanup();
  }
});

test("shows dictation failure when the terminal prompt starts it by shortcut", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "terminal-dictation-permission-" });
  const profile = {
    id: "echo-prompt",
    name: "Echo prompt",
    command: "echo",
    args: ["{{{prompt}}}"],
  };
  const profiles = await seedTerminalProfiles([profile]);
  await installDictationFailureHarness(page);
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, workspace);
    await selectLaunchOption(page, profile.id);

    const setMicrophonePermission = await controlMicrophonePermission(page);
    await setMicrophonePermission("denied");
    await terminalPromptInput(page).press("Control+d");
    await expectDictationPermissionError(page);
  } finally {
    await profiles.restore();
    await workspace.cleanup();
  }
});
