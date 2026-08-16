import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { openNewWorkspaceComposer, selectWorkspaceRuntime } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

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
      await selectWorkspaceRuntime(page, "local");

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
