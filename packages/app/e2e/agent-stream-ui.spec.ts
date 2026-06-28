import { test, expect, type Page } from "./fixtures";
import {
  awaitAssistantMessage,
  expectAgentIdle,
  expectInlineWorkingIndicator,
  expectTurnCopyButton,
  expectScrollFollowsNewContent,
} from "./helpers/agent-stream";
import { readScrollMetrics } from "./helpers/agent-bottom-anchor";
import { daemonWsRoutePattern } from "./helpers/daemon-port";
import { clickNewChat } from "./helpers/launcher";
import { expectComposerVisible, startRunningMockAgent } from "./helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";

type WebSocketMessage = string | Buffer;

function parseWebSocketJson(message: WebSocketMessage): unknown {
  const rawMessage = typeof message === "string" ? message : message.toString("utf8");
  try {
    return JSON.parse(rawMessage);
  } catch {
    return null;
  }
}

function getSessionMessage(message: WebSocketMessage): Record<string, unknown> | null {
  const envelope = parseWebSocketJson(message);
  if (!envelope || typeof envelope !== "object") {
    return null;
  }
  const maybeEnvelope = envelope as { type?: unknown; message?: unknown };
  if (maybeEnvelope.type !== "session" || !maybeEnvelope.message) {
    return null;
  }
  if (typeof maybeEnvelope.message !== "object") {
    return null;
  }
  return maybeEnvelope.message as Record<string, unknown>;
}

function getPayload(message: Record<string, unknown>): Record<string, unknown> | null {
  return message.payload && typeof message.payload === "object"
    ? (message.payload as Record<string, unknown>)
    : null;
}

async function delayCreatedAgentInitialTailResponse(page: Page): Promise<{
  release(): void;
  waitForCreatedAgent(): Promise<string>;
  waitForDelayedResponse(): Promise<void>;
}> {
  let createdAgentId: string | null = null;
  let releaseRequested = false;
  let delayedResponseSeen = false;
  const delayedForwards: Array<() => void> = [];
  let resolveCreatedAgent: ((agentId: string) => void) | null = null;
  let resolveDelayedResponse: (() => void) | null = null;
  const createdAgentSeen = new Promise<string>((resolve) => {
    resolveCreatedAgent = resolve;
  });
  const delayedResponse = new Promise<void>((resolve) => {
    resolveDelayedResponse = resolve;
  });

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      server.send(message);
    });

    server.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      const payload = sessionMessage ? getPayload(sessionMessage) : null;
      if (sessionMessage?.type === "status" && payload?.status === "agent_created") {
        const agentId = payload.agentId;
        if (typeof agentId === "string") {
          createdAgentId = agentId;
          resolveCreatedAgent?.(agentId);
        }
      }

      if (sessionMessage?.type === "fetch_agent_timeline_response") {
        const agentId = payload?.agentId;
        const direction = payload?.direction;
        if (
          !delayedResponseSeen &&
          typeof agentId === "string" &&
          agentId === createdAgentId &&
          direction === "tail"
        ) {
          delayedResponseSeen = true;
          resolveDelayedResponse?.();
          if (releaseRequested) {
            ws.send(message);
            return;
          }
          delayedForwards.push(() => ws.send(message));
          return;
        }
      }

      ws.send(message);
    });
  });

  return {
    release() {
      releaseRequested = true;
      for (const forward of delayedForwards.splice(0)) {
        forward();
      }
    },
    waitForCreatedAgent: () => createdAgentSeen,
    waitForDelayedResponse: () => delayedResponse,
  };
}

async function preferFiveMinuteMockStream(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const raw = localStorage.getItem("@paseo:create-agent-preferences");
    const parsed = raw ? JSON.parse(raw) : {};
    localStorage.setItem(
      "@paseo:create-agent-preferences",
      JSON.stringify({
        ...parsed,
        provider: "mock",
        providerPreferences: {
          ...parsed.providerPreferences,
          mock: {
            ...parsed.providerPreferences?.mock,
            mode: "load-test",
            model: "five-minute-stream",
          },
        },
      }),
    );
  });
}

test.describe("Agent stream UI", () => {
  test("auto-scroll sticks to bottom across token bursts", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await startRunningMockAgent(page, {
      prefix: "stream-scroll-",
      model: "one-minute-stream",
      prompt: "Stream for auto-scroll test.",
    });
    try {
      await awaitAssistantMessage(page);
      await expectScrollFollowsNewContent(page);
    } finally {
      await agent.cleanup();
    }
  });

  test("keeps the viewport fixed after the user scrolls away during a stream", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "stream-scroll-away-",
      title: "Scroll-away anchor",
      model: "five-minute-stream",
      initialPrompt: "emit 120 agent stream updates for scroll-away setup.",
    });
    try {
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await openAgentRoute(page, {
        workspaceId: agent.workspaceId,
        agentId: agent.agentId,
      });
      await expectComposerVisible(page);
      await agent.client.sendAgentMessage(agent.agentId, "Stream for scroll-away anchor test.");
      await expect(page.getByRole("button", { name: /stop|cancel/i }).first()).toBeVisible({
        timeout: 30_000,
      });
      await awaitAssistantMessage(page);
      await expect
        .poll(
          async () => {
            const metrics = await readScrollMetrics(page);
            return metrics.contentHeight - metrics.viewportHeight;
          },
          { timeout: 30_000 },
        )
        .toBeGreaterThan(900);

      const scroll = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
      const box = await scroll.boundingBox();
      if (!box) {
        throw new Error("Agent chat scroll container is not visible");
      }
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -900);

      await expect
        .poll(async () => {
          const metrics = await readScrollMetrics(page);
          return metrics.distanceFromBottom;
        })
        .toBeGreaterThan(300);

      const baseline = await readScrollMetrics(page);
      const samples: Array<{ elapsedMs: number; offsetY: number; contentHeight: number }> = [];
      const startedAt = Date.now();
      while (Date.now() - startedAt < 30_000) {
        await page.waitForTimeout(250);
        const metrics = await readScrollMetrics(page);
        samples.push({
          elapsedMs: Date.now() - startedAt,
          offsetY: metrics.offsetY,
          contentHeight: metrics.contentHeight,
        });
        expect(
          metrics.offsetY,
          JSON.stringify({ baseline, samples: samples.slice(-12) }),
        ).toBeLessThanOrEqual(baseline.offsetY + 24);
      }

      const finalMetrics = await readScrollMetrics(page);
      expect(finalMetrics.contentHeight).toBeGreaterThan(baseline.contentHeight);
    } finally {
      await agent.cleanup();
    }
  });

  test("keeps the viewport fixed when delayed authoritative history arrives after scroll-away", async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(180_000);
    const timelineGate = await delayCreatedAgentInitialTailResponse(page);
    await preferFiveMinuteMockStream(page);
    const workspace = await withWorkspace({ prefix: "stream-scroll-away-delayed-history-" });
    await workspace.navigateTo();
    await clickNewChat(page);
    await page.getByText("Model defaults are still loading").waitFor({
      state: "hidden",
      timeout: 30_000,
    });

    const prompt = "Stream for delayed authoritative history scroll-away test.";
    const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
    await composer.fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByText(prompt, { exact: true }).first().waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await timelineGate.waitForCreatedAgent();
    await timelineGate.waitForDelayedResponse();
    await expect(page.getByRole("button", { name: /stop|cancel/i }).first()).toBeVisible({
      timeout: 30_000,
    });
    await awaitAssistantMessage(page);
    await expect
      .poll(
        async () => {
          const metrics = await readScrollMetrics(page);
          return metrics.contentHeight - metrics.viewportHeight;
        },
        { timeout: 45_000 },
      )
      .toBeGreaterThan(900);

    const scroll = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
    const box = await scroll.boundingBox();
    if (!box) {
      throw new Error("Agent chat scroll container is not visible");
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -900);

    await expect
      .poll(async () => {
        const metrics = await readScrollMetrics(page);
        return metrics.distanceFromBottom;
      })
      .toBeGreaterThan(300);

    const baseline = await readScrollMetrics(page);
    timelineGate.release();
    await page.waitForTimeout(750);
    const afterRelease = await readScrollMetrics(page);
    expect(afterRelease.offsetY, JSON.stringify({ baseline, afterRelease })).toBeLessThanOrEqual(
      baseline.offsetY + 24,
    );
  });

  test("working-indicator transitions to copy-button when stream ends", async ({ page }) => {
    test.setTimeout(60_000);
    const agent = await startRunningMockAgent(page, {
      prefix: "stream-indicator-",
      model: "ten-second-stream",
      prompt: "Stream briefly for indicator transition test.",
    });
    try {
      await awaitAssistantMessage(page);
      await expectInlineWorkingIndicator(page);
      await expectAgentIdle(page, 30_000);
      await expectTurnCopyButton(page);
    } finally {
      await agent.cleanup();
    }
  });

  test("shows elapsed timer on first app-created running turn", async ({ page, withWorkspace }) => {
    test.setTimeout(90_000);
    const workspace = await withWorkspace({ prefix: "stream-first-app-turn-timer-" });
    await workspace.navigateTo();
    await clickNewChat(page);
    await page.getByText("Model defaults are still loading").waitFor({
      state: "hidden",
      timeout: 30_000,
    });
    const prompt = "Stream briefly for first app-created turn timer test.";
    const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
    await composer.fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByText(prompt, { exact: true }).first().waitFor({ state: "visible" });
    await awaitAssistantMessage(page);
    await expectInlineWorkingIndicator(page);
    await page.getByTestId("turn-working-elapsed").waitFor({ state: "visible", timeout: 5_000 });
  });
});
