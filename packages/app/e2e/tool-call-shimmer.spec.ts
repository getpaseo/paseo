import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { daemonWsRoutePattern } from "./helpers/daemon-port";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";

type WebSocketMessage = string | Buffer;

interface ShimmerEvidence {
  animationDuration: string;
  endPx: number;
  label: string;
  renderedWidth: number;
  startPx: number;
}

function parseSessionMessage(message: WebSocketMessage): Record<string, unknown> | null {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    const envelope = JSON.parse(raw) as { type?: unknown; message?: unknown };
    return envelope.type === "session" && envelope.message && typeof envelope.message === "object"
      ? (envelope.message as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function getToolCallStatus(
  message: WebSocketMessage,
  agentId: string,
): { callId: string; status: string } | null {
  const sessionMessage = parseSessionMessage(message);
  if (sessionMessage?.type !== "agent_stream") {
    return null;
  }
  const payload = sessionMessage.payload as Record<string, unknown> | undefined;
  if (payload?.agentId !== agentId) {
    return null;
  }
  const event = payload.event as Record<string, unknown> | undefined;
  const item = event?.item as Record<string, unknown> | undefined;
  return event?.type === "timeline" &&
    item?.type === "tool_call" &&
    typeof item.callId === "string" &&
    typeof item.status === "string"
    ? { callId: item.callId, status: item.status }
    : null;
}

function replaceToolCallStatus(message: WebSocketMessage, status: string): string {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  const envelope = JSON.parse(raw) as {
    message?: { payload?: { event?: { item?: { status?: string } } } };
  };
  const item = envelope.message?.payload?.event?.item;
  if (!item) {
    throw new Error("Expected a tool-call session message");
  }
  item.status = status;
  return JSON.stringify(envelope);
}

async function gateSecondToolCall(page: Page, agentId: string) {
  let firstCallId: string | null = null;
  let secondCallId: string | null = null;
  let secondRunningMessage: WebSocketMessage | null = null;
  let releaseSecondRequested = false;
  let pauseServerMessages = false;
  let secondRunningForwarded = false;
  let forwardSecondRunning: (() => void) | null = null;
  let resolveFirstCompleted!: () => void;
  let resolveSecondRunning!: () => void;
  const firstCompleted = new Promise<void>((resolve) => {
    resolveFirstCompleted = resolve;
  });
  const secondRunning = new Promise<void>((resolve) => {
    resolveSecondRunning = resolve;
  });

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    forwardSecondRunning = () => {
      if (!secondRunningMessage || secondRunningForwarded) {
        return;
      }
      ws.send(secondRunningMessage);
      secondRunningForwarded = true;
    };
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (pauseServerMessages) {
        return;
      }

      const toolCall = getToolCallStatus(message, agentId);
      if (!toolCall) {
        ws.send(message);
        return;
      }
      if (!firstCallId) {
        firstCallId = toolCall.callId;
      }
      if (toolCall.callId === firstCallId) {
        if (toolCall.status === "running" || toolCall.status === "executing") {
          return;
        }
        if (toolCall.status === "completed") {
          // The mock tool completes inside the daemon's coalescing window, so the
          // browser naturally receives its authoritative completed state first.
          ws.send(message);
          resolveFirstCompleted();
          return;
        }
      }

      secondCallId ??= toolCall.callId;
      if (
        toolCall.callId === secondCallId &&
        (toolCall.status === "running" || toolCall.status === "executing")
      ) {
        secondRunningMessage = message;
        pauseServerMessages = true;
        resolveSecondRunning();
        if (releaseSecondRequested) {
          forwardSecondRunning?.();
        }
        return;
      }

      if (toolCall.callId === secondCallId && toolCall.status === "completed") {
        // Keep the second real tool call inspectably active. Production providers
        // send this same status shape while their work remains in flight.
        secondRunningMessage = replaceToolCallStatus(message, "running");
        pauseServerMessages = true;
        resolveSecondRunning();
        if (releaseSecondRequested) {
          forwardSecondRunning?.();
        }
        return;
      }

      ws.send(message);
    });
  });

  return {
    waitForFirstCompleted: () => firstCompleted,
    waitForSecondRunning: () => secondRunning,
    releaseSecondRunning() {
      releaseSecondRequested = true;
      if (secondRunningMessage) {
        forwardSecondRunning?.();
      }
    },
  };
}

async function readShimmerEvidence(locator: Locator): Promise<ShimmerEvidence> {
  return locator.evaluate((root) => {
    const shimmer = Array.from(root.querySelectorAll<HTMLElement>("*")).find((element) =>
      getComputedStyle(element).animationName.includes("paseo-toolcall-shimmer"),
    );
    if (!shimmer) {
      throw new Error("Expected a running shimmer inside the badge");
    }
    const style = getComputedStyle(shimmer);
    return {
      animationDuration: style.animationDuration,
      endPx: Number.parseFloat(style.getPropertyValue("--paseo-shimmer-end")),
      label: shimmer.textContent ?? "",
      renderedWidth: shimmer.getBoundingClientRect().width,
      startPx: Number.parseFloat(style.getPropertyValue("--paseo-shimmer-start")),
    };
  });
}

test("measures an overview heading that becomes loading after its idle mount", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    localStorage.setItem(
      "@paseo:app-settings",
      JSON.stringify({ toolCallDetailLevel: "overview" }),
    );
  });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "tool-call-shimmer-",
    title: "Tool-call shimmer",
    model: "ten-second-stream",
  });

  try {
    const gate = await gateSecondToolCall(page, agent.agentId);
    await openAgentRoute(page, {
      workspaceId: agent.workspaceId,
      agentId: agent.agentId,
    });
    await agent.client.sendAgentMessage(agent.agentId, "Prove the overview shimmer lifecycle.");

    await gate.waitForFirstCompleted();
    const group = page.getByTestId("tool-call-group");
    await expect(group).toBeVisible();
    const idleGroupHandle = await group.elementHandle();
    if (!idleGroupHandle) {
      throw new Error("Expected the idle tool-call group to be mounted");
    }
    await expect(group.locator('[style*="paseo-toolcall-shimmer"]')).toHaveCount(0);

    await gate.waitForSecondRunning();
    gate.releaseSecondRunning();
    await expect(group.locator('[style*="paseo-toolcall-shimmer"]')).not.toHaveCount(0);
    const sameGroupNode = await group.evaluate(
      (node, previous) => node === previous,
      idleGroupHandle,
    );

    await group.click();
    const runningChild = page.getByTestId("tool-call-badge").last();
    await expect(runningChild).toBeVisible();
    const header = await readShimmerEvidence(group);
    const child = await readShimmerEvidence(runningChild);
    const evidence = { sameGroupNode, header, child };
    await testInfo.attach("tool-call-shimmer-evidence", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });

    expect(sameGroupNode).toBe(true);
    expect(child.endPx).toBeGreaterThan(0);
    expect(
      header.endPx,
      `The retained header rendered ${header.renderedWidth}px wide but its shimmer still ends at ${header.endPx}px`,
    ).toBeGreaterThan(0);
  } finally {
    await agent.cleanup();
  }
});
