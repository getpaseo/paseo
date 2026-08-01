import { expect, type Page } from "@playwright/test";
import { scrollAgentChatToBottom } from "./agent-bottom-anchor";
import { getE2EDaemonPort } from "./daemon-port";

type WebSocketMessage = string | Buffer;

interface SessionMessage {
  type?: unknown;
  payload?: unknown;
}

interface ForkContextResponsePayload {
  attachment?: { text?: unknown } | null;
}

function readSessionMessage(message: WebSocketMessage): SessionMessage | null {
  if (typeof message !== "string") return null;
  try {
    const envelope = JSON.parse(message) as { type?: unknown; message?: SessionMessage };
    return envelope.type === "session" ? (envelope.message ?? null) : envelope;
  } catch {
    return null;
  }
}

export function observeForkAttachment(page: Page): {
  waitForText: () => Promise<string>;
} {
  const attachmentTexts: string[] = [];
  const daemonPortMarker = `:${getE2EDaemonPort()}`;

  page.on("websocket", (socket) => {
    if (!socket.url().includes(daemonPortMarker)) return;
    socket.on("framereceived", ({ payload }) => {
      const message = readSessionMessage(payload);
      if (message?.type === "agent.fork_context.response") {
        const response = (message.payload ?? {}) as ForkContextResponsePayload;
        attachmentTexts.push(String(response.attachment?.text ?? ""));
      }
    });
  });

  return {
    async waitForText() {
      await expect.poll(() => attachmentTexts.length, { timeout: 30_000 }).toBeGreaterThan(0);
      const text = attachmentTexts.at(-1);
      if (text === undefined) {
        throw new Error("Expected a chat history attachment from the fork");
      }
      return text;
    },
  };
}

function inFlightTurn(page: Page) {
  return page.getByTestId("turn-working-indicator");
}

async function openForkMenu(page: Page, trigger: ReturnType<Page["getByRole"]>): Promise<void> {
  await trigger.click();
  await expect(page.getByRole("button", { name: "Fork in a new tab" })).toBeVisible({
    timeout: 10_000,
  });
}

export async function openMostRecentAssistantForkMenu(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        await scrollAgentChatToBottom(page);
        return page.getByRole("button", { name: "Fork chat" }).count();
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const trigger = page.getByRole("button", { name: "Fork chat" }).last();
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await openForkMenu(page, trigger);
}

export async function forkMostRecentAssistantTurnToNewTab(page: Page): Promise<void> {
  await openMostRecentAssistantForkMenu(page);
  await page.getByRole("button", { name: "Fork in a new tab" }).click();
}

export async function expectInFlightForkAvailable(page: Page): Promise<void> {
  const trigger = inFlightTurn(page).getByRole("button", { name: "Fork chat" });
  await expect(trigger).toHaveCount(1, { timeout: 30_000 });
  await expect(trigger).toBeVisible();
}

export async function forkInFlightTurnToNewTab(page: Page): Promise<void> {
  const trigger = inFlightTurn(page).getByRole("button", { name: "Fork chat" });
  await openForkMenu(page, trigger);
  await page.getByRole("button", { name: "Fork in a new tab" }).click();
}

export async function forkMostRecentAssistantTurnToNewWorkspace(page: Page): Promise<void> {
  await openMostRecentAssistantForkMenu(page);
  await page.getByRole("button", { name: "Fork in a new workspace" }).click();
}

export async function expectChatHistoryAttachment(page: Page): Promise<void> {
  const attachment = page.getByRole("button", { name: "Open chat history attachment" }).first();
  await expect(attachment).toBeVisible({ timeout: 30_000 });
  await expect(attachment).toContainText("Chat history");
}

export async function expectLiveAssistantText(page: Page, text: string): Promise<void> {
  await expect(inFlightTurn(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("assistant-message").last()).toContainText(text, {
    timeout: 60_000,
  });
}
