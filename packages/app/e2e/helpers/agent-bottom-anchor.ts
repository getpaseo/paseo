import { expect, type Page } from "@playwright/test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  buildHostWorkspaceAgentRoute,
  buildHostWorkspaceRoute,
} from "../../src/utils/host-routes";

const NEAR_BOTTOM_THRESHOLD_PX = 72;

export type ScrollMetrics = {
  offsetY: number;
  contentHeight: number;
  viewportHeight: number;
  distanceFromBottom: number;
};

export type SeededAgent = {
  id: string;
  title: string;
  expectedTailText: string;
  url: string;
  workspaceUrl: string;
};

export type DaemonClientInstance = {
  connect(): Promise<void>;
  close(): Promise<void>;
  createAgent(options: {
    provider: string;
    model: string;
    thinkingOptionId: string;
    modeId: string;
    cwd: string;
    title: string;
    initialPrompt: string;
  }): Promise<{ id: string }>;
  sendAgentMessage(agentId: string, text: string): Promise<void>;
  waitForFinish(
    agentId: string,
    timeout?: number
  ): Promise<{ status: string }>;
};

function getDaemonWsUrl(): string {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  if (!daemonPort) {
    throw new Error("E2E_DAEMON_PORT is not set.");
  }
  return `ws://127.0.0.1:${daemonPort}/ws`;
}

function getServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set.");
  }
  return serverId;
}

function buildReplyBlock(label: string, lineCount = 14): string {
  return Array.from({ length: lineCount }, (_, index) => {
    const line = (index + 1).toString().padStart(2, "0");
    return `${label} line ${line} anchor verification text keeps wrapping stable across resize and composer growth.`;
  }).join("\n");
}

function buildProtocolMessage(label: string, lineCount = 14): string {
  return [
    "For every message in this chat, reply with exactly the text after the final line `REPLY:`.",
    "Do not add extra words, bullets, markdown fences, or tool calls.",
    "REPLY:",
    buildReplyBlock(label, lineCount),
  ].join("\n");
}

function buildReplyMessage(label: string, lineCount = 14): string {
  return ["REPLY:", buildReplyBlock(label, lineCount)].join("\n");
}

export function createReplyTurn(label: string): {
  message: string;
  expectedReply: string;
} {
  return {
    message: buildReplyMessage(label),
    expectedReply: buildReplyBlock(label),
  };
}

async function loadDaemonClientConstructor(): Promise<new (config: {
  url: string;
  clientId: string;
  clientType: "cli";
}) => DaemonClientInstance> {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, "packages/server/dist/server/server/exports.js")
  ).href;
  const mod = (await import(moduleUrl)) as {
    DaemonClient: new (config: {
      url: string;
      clientId: string;
      clientType: "cli";
    }) => DaemonClientInstance;
  };
  return mod.DaemonClient;
}

export async function connectDaemonClient(): Promise<DaemonClientInstance> {
  const DaemonClient = await loadDaemonClientConstructor();
  const client = new DaemonClient({
    url: getDaemonWsUrl(),
    clientId: `app-e2e-${randomUUID()}`,
    clientType: "cli",
  });
  await client.connect();
  return client;
}

export async function seedBottomAnchorAgent(input: {
  client: DaemonClientInstance;
  cwd: string;
  title?: string;
  turnCount?: number;
  lineCount?: number;
}): Promise<SeededAgent> {
  const title = input.title ?? `bottom-anchor-${Date.now()}`;
  const turnCount = Math.max(3, input.turnCount ?? 5);
  const lineCount = Math.max(14, input.lineCount ?? 14);
  const created = await input.client.createAgent({
    provider: "codex",
    model: "gpt-5.1-codex-mini",
    thinkingOptionId: "low",
    modeId: "full-access",
    cwd: input.cwd,
    title,
    initialPrompt: buildProtocolMessage(`${title}-turn-00`, lineCount),
  });
  const initialFinish = await input.client.waitForFinish(created.id, 120000);
  if (initialFinish.status !== "idle") {
    throw new Error(
      `Expected seeded agent ${created.id} to become idle after initial prompt, got ${initialFinish.status}.`
    );
  }

  let expectedTailText = buildReplyBlock(`${title}-turn-00`, lineCount);
  for (let index = 1; index < turnCount; index += 1) {
    const label = `${title}-turn-${index.toString().padStart(2, "0")}`;
    expectedTailText = buildReplyBlock(label, lineCount);
    await input.client.sendAgentMessage(created.id, buildReplyMessage(label, lineCount));
    const finish = await input.client.waitForFinish(created.id, 120000);
    if (finish.status !== "idle") {
      throw new Error(
        `Expected seeded agent ${created.id} to become idle after turn ${index}, got ${finish.status}.`
      );
    }
  }

  return {
    id: created.id,
    title,
    expectedTailText,
    url: buildHostWorkspaceAgentRoute(getServerId(), input.cwd, created.id),
    workspaceUrl: buildHostWorkspaceRoute(getServerId(), input.cwd),
  };
}

function getVisibleChatScroll(page: Page) {
  return page.locator('[data-testid="agent-chat-scroll"]:visible').first();
}

export async function readScrollMetrics(page: Page): Promise<ScrollMetrics> {
  return getVisibleChatScroll(page).evaluate((root: Element) => {
    const candidates = [root, ...Array.from(root.querySelectorAll("*"))]
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .filter((element) => {
        const tagName = element.tagName.toLowerCase();
        const isEditable =
          tagName === "textarea" ||
          tagName === "input" ||
          element.getAttribute("contenteditable") === "true";
        return !isEditable && element.scrollHeight - element.clientHeight > 1;
      });
    const scrollElement =
      candidates.sort(
        (left, right) =>
          right.scrollHeight -
          right.clientHeight -
          (left.scrollHeight - left.clientHeight)
      )[0] ?? (root as HTMLElement);

    const offsetY = Math.max(0, scrollElement.scrollTop);
    const contentHeight = Math.max(0, scrollElement.scrollHeight);
    const viewportHeight = Math.max(0, scrollElement.clientHeight);
    const distanceFromBottom = Math.max(
      0,
      contentHeight - (offsetY + viewportHeight)
    );

    return {
      offsetY,
      contentHeight,
      viewportHeight,
      distanceFromBottom,
    };
  });
}

export async function scrollUpFromBottom(page: Page, pixels: number): Promise<void> {
  const scrollViewport = getVisibleChatScroll(page);
  await expect(scrollViewport).toHaveCount(1, { timeout: 30000 });
  let remaining = Math.max(0, pixels);
  while (remaining > 0) {
    const delta = Math.min(240, remaining);
    await scrollViewport.evaluate((element: Element, step: number) => {
      const scrollContainer = element as HTMLElement;
      scrollContainer.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -step,
          bubbles: true,
          cancelable: true,
        })
      );
      scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollTop - step);
      scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, delta);
    remaining -= delta;

    if ((await readScrollMetrics(page)).distanceFromBottom > NEAR_BOTTOM_THRESHOLD_PX) {
      return;
    }
  }
}

export async function waitForAgentReady(page: Page, expectedTailText?: string): Promise<void> {
  await expect(getVisibleChatScroll(page)).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toBeVisible({
    timeout: 60000,
  });
  await expect(page.getByTestId("agent-loading")).toHaveCount(0, { timeout: 60000 });
  if (expectedTailText) {
    await expect
      .poll(async () => {
        const metrics = await readScrollMetrics(page);
        return metrics.contentHeight;
      })
      .toBeGreaterThan(0);
  }
}

export async function expectNearBottom(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const metrics = await readScrollMetrics(page);
      return metrics.distanceFromBottom;
    })
    .toBeLessThanOrEqual(NEAR_BOTTOM_THRESHOLD_PX);
}

export async function expectDetachedFromBottom(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const metrics = await readScrollMetrics(page);
      return metrics.distanceFromBottom;
    })
    .toBeGreaterThan(NEAR_BOTTOM_THRESHOLD_PX);
}

export async function waitForContentGrowth(
  page: Page,
  previousContentHeight: number
): Promise<ScrollMetrics> {
  await expect
    .poll(async () => {
      const metrics = await readScrollMetrics(page);
      return metrics.contentHeight;
    })
    .toBeGreaterThan(previousContentHeight);
  return readScrollMetrics(page);
}

export async function getChatContainerKey(page: Page): Promise<string | null> {
  return getVisibleChatScroll(page).evaluate((element) => {
      const nativeId = (element as HTMLElement).id;
      const prefix = "agent-chat-scroll-";
      return nativeId.startsWith(prefix) ? nativeId.slice(prefix.length) : null;
    });
}
