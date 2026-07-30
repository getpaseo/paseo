import { expect, test as base, type Page } from "./fixtures";
import { scrollAgentChatToBottom } from "./helpers/agent-bottom-anchor";
import { awaitAssistantMessage } from "./helpers/agent-stream";
import { expectComposerVisible, submitMessage } from "./helpers/composer";
import { getE2EDaemonPort } from "./helpers/daemon-port";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentOptions,
  type MockAgentWorkspace,
} from "./helpers/mock-agent";
import { getServerId } from "./helpers/server-id";
import { seedSavedSettingsHosts } from "./helpers/settings";
import { submitNewWorkspaceEmpty } from "./helpers/new-workspace";

const test = base.extend<{
  seedForkWorkspace: (options: MockAgentOptions) => Promise<MockAgentWorkspace>;
}>({
  seedForkWorkspace: async ({ browserName: _browserName }, provide) => {
    const sessions: MockAgentWorkspace[] = [];
    await provide(async (options) => {
      const session = await seedMockAgentWorkspace(options);
      sessions.push(session);
      return session;
    });
    await Promise.allSettled(sessions.map((session) => session.cleanup()));
  },
});

async function openAssistantForkMenu(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        await scrollAgentChatToBottom(page);
        return page.getByTestId("assistant-fork-menu-trigger").count();
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const trigger = page.getByTestId("assistant-fork-menu-trigger").last();
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();
  await expect(page.getByTestId("assistant-fork-menu-content")).toBeVisible({
    timeout: 10_000,
  });
}

async function expectChatHistoryPill(page: Page): Promise<void> {
  const pill = page.getByTestId("composer-chat-history-attachment-pill").first();
  await expect(pill).toBeVisible({ timeout: 30_000 });
  await expect(pill).toContainText("Chat history");
}

type WebSocketMessage = string | Buffer;

interface SessionMessage {
  type?: unknown;
  payload?: unknown;
}

/** Mirrors the fields of `agent.fork_context.request` this spec asserts on. */
interface ForkContextRequestFrame extends SessionMessage {
  agentId?: unknown;
}

/** Mirrors the `agent.fork_context.response` payload this spec asserts on. */
interface ForkContextResponsePayload {
  agentId?: unknown;
  attachment?: { text?: unknown } | null;
  itemCount?: unknown;
  boundaryMessageId?: unknown;
  boundaryCursor?: unknown;
}

// Copy of the envelope reader that every WebSocket-observing spec keeps local
// (see helpers/timeline-delivery.ts, helpers/daemon-websocket-gate.ts). Both
// directions use the same `{ type: "session", message }` envelope.
function readSessionMessage(message: WebSocketMessage): SessionMessage | null {
  if (typeof message !== "string") return null;
  try {
    const envelope = JSON.parse(message) as { type?: unknown; message?: SessionMessage };
    return envelope.type === "session" ? (envelope.message ?? null) : envelope;
  } catch {
    return null;
  }
}

/**
 * Records both halves of the `agent.fork_context` exchange straight off the
 * wire. The boundary the client sends is the whole point of the in-flight fork,
 * and it is invisible from the DOM — the request frame is the only place it can
 * be observed. Read-only: this attaches to `page.on("websocket")` rather than
 * proxying via `routeWebSocket`, so it cannot perturb the flow it measures.
 *
 * Install before the first navigation; sockets opened earlier are never seen.
 */
function observeForkContextExchange(page: Page) {
  const requests: ForkContextRequestFrame[] = [];
  const responses: ForkContextResponsePayload[] = [];
  const daemonPortMarker = `:${getE2EDaemonPort()}`;

  page.on("websocket", (socket) => {
    // Metro's HMR socket shares the page; only the daemon speaks this protocol.
    if (!socket.url().includes(daemonPortMarker)) return;
    socket.on("framesent", ({ payload }) => {
      const message = readSessionMessage(payload);
      if (message?.type !== "agent.fork_context.request") return;
      requests.push(message as ForkContextRequestFrame);
    });
    socket.on("framereceived", ({ payload }) => {
      const message = readSessionMessage(payload);
      if (message?.type !== "agent.fork_context.response") return;
      responses.push((message.payload ?? {}) as ForkContextResponsePayload);
    });
  });

  return {
    async waitForExchange(): Promise<{
      request: ForkContextRequestFrame;
      response: ForkContextResponsePayload;
    }> {
      await expect
        .poll(() => Math.min(requests.length, responses.length), { timeout: 30_000 })
        .toBeGreaterThan(0);
      const request = requests.at(-1);
      const response = responses.at(-1);
      if (!request || !response) {
        throw new Error("Expected an agent.fork_context request/response pair on the wire.");
      }
      return { request, response };
    },
  };
}

/**
 * The in-flight fork trigger, scoped inside the running turn's footer. Scoping
 * is load-bearing: an unscoped `.last()` would also match a completed turn's
 * fork button, so this locator is what makes "the affordance exists *while
 * streaming*" a real assertion rather than a page-wide existence check.
 */
function inFlightForkTrigger(page: Page) {
  return page.getByTestId("turn-working-indicator").getByTestId("assistant-fork-menu-trigger");
}

async function openInFlightForkMenu(page: Page): Promise<void> {
  await inFlightForkTrigger(page).click();
  await expect(page.getByTestId("assistant-fork-menu-content")).toBeVisible({ timeout: 10_000 });
}

const WHITESPACE = /\s+/g;

function normalizeStreamText(text: string): string {
  return text.replace(WHITESPACE, " ").trim();
}

/**
 * Reads the live assistant text and returns a short tail of whole words from
 * it, for matching against the fork attachment. Guardrails, in order:
 *
 * - Sliced to the first 400 characters. The mock's opening paragraph is plain
 *   prose; later cycle content has code fences and bullet markdown whose DOM
 *   text would not match the raw attachment text.
 * - The final word is dropped — it can be a token that is still arriving.
 * - Whitespace-normalized on both sides, since the markdown renderer's block
 *   layout does not reproduce the attachment's exact newlines.
 *
 * The tail stays valid across the click that follows: streamed text only ever
 * grows, so a tail sampled at T is still present in the attachment built at
 * T+delta.
 */
function takeStreamedTail(text: string): string {
  const words = normalizeStreamText(text.slice(0, 400)).split(" ");
  const tail = words.slice(-9, -1);
  return tail.join(" ");
}

function liveAssistantText(page: Page): Promise<string> {
  return page.getByTestId("assistant-message").last().innerText();
}

test.describe("Assistant fork menu", () => {
  test.describe.configure({ timeout: 180_000 });

  test("forks a failed assistant turn that has no provider message id", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-failed-turn-",
      title: "Assistant fork failed turn",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await submitMessage(page, "Emit a synthetic turn failure.");
    await expect(page.getByText("[System Error] Requested mock provider failure")).toBeVisible({
      timeout: 30_000,
    });

    await openAssistantForkMenu(page);
    await page.getByTestId("assistant-fork-menu-new-tab").click();
    await expectChatHistoryPill(page);
  });

  test("forks the in-flight turn with no boundary and captures the streaming response", async ({
    page,
    seedForkWorkspace,
  }) => {
    // A distinctive token in the prompt gives the attachment a verbatim string
    // to match that does not depend on stream timing. The user message belongs
    // to the in-flight turn, so a fork that pinned a boundary at the previous
    // assistant message would exclude it.
    const marker = "forkinflightmarker7";
    const forkContext = observeForkContextExchange(page);

    // No initialPrompt, so the page has exactly one turn and it is in-flight —
    // which is what lets the "no completed-turn affordance" assertions below be
    // page-wide instead of merely scoped. `thirty-minute-stream` holds the run
    // open for the whole test; the fixture's `removeProject` teardown archives
    // the agent, which closes the provider session and clears the mock's timer,
    // so the run does not outlive the test on this shard's shared daemon.
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-in-flight-",
      title: "Assistant fork in flight",
      model: "thirty-minute-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await submitMessage(page, `${marker} walk me through the scroll anchor behavior.`);

    // The fork affordance lives in the running turn's footer, beside the loader.
    await expect(inFlightForkTrigger(page)).toHaveCount(1, { timeout: 30_000 });
    await expect(inFlightForkTrigger(page)).toBeVisible();

    // Nothing that belongs to a *completed* turn may leak onto the incomplete
    // one. Page-wide because the only turn on this page is the running one.
    await expect(page.getByRole("button", { name: "Copy turn" })).toHaveCount(0);
    await expect(page.getByText(/Worked for/)).toHaveCount(0);

    // Wait for real streamed text before forking — the trigger appears the
    // instant the run starts, well before any token arrives.
    await expect
      .poll(async () => (await liveAssistantText(page)).length, { timeout: 60_000 })
      .toBeGreaterThan(200);
    const textAtFork = await liveAssistantText(page);
    const streamedTail = takeStreamedTail(textAtFork);
    expect(streamedTail.split(" ")).toHaveLength(8);

    await openInFlightForkMenu(page);
    await page.getByTestId("assistant-fork-menu-new-tab").click();
    await expectChatHistoryPill(page);

    const { request, response } = await forkContext.waitForExchange();
    expect(request.agentId).toBe(session.agentId);

    // The load-bearing contract. The client omits both boundary fields (they
    // are `.optional()` on the wire schema, so they are absent rather than
    // null), and the daemon answers with an explicitly unbounded projection.
    expect("boundaryMessageId" in request).toBe(false);
    expect("boundaryCursor" in request).toBe(false);
    expect(response.boundaryMessageId).toBeNull();
    expect(response.boundaryCursor ?? null).toBeNull();

    // The fork carries the turn that is still streaming: the prompt that
    // started it, and the assistant text rendered a moment ago.
    const attachmentText = String(response.attachment?.text ?? "");
    expect(attachmentText).toContain(marker);
    expect(normalizeStreamText(attachmentText)).toContain(streamedTail);
    expect(response.itemCount).toBeGreaterThan(0);

    // Forking is a copy, not a handoff: the source agent keeps running. The
    // stream view freezes hidden tab slots, so return to the agent tab first.
    await page.getByTestId(`workspace-tab-agent_${session.agentId}`).click();
    await expect(page.getByTestId("turn-working-indicator")).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => (await liveAssistantText(page)).length, { timeout: 60_000 })
      .toBeGreaterThan(textAtFork.length);
  });

  test("focuses a forked assistant turn in a new workspace draft tab", async ({
    page,
    seedForkWorkspace,
  }) => {
    const forkContext = observeForkContextExchange(page);
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-focused-tab-",
      title: "Assistant fork focused tab",
      initialPrompt: "emit 1 coalesced agent stream updates for initial assistant fork turn.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await submitMessage(page, "emit 1 coalesced agent stream updates while this tab is visible.");
    await session.client.waitForFinish(session.agentId, 45_000);
    await awaitAssistantMessage(page);

    const agentTab = page.getByTestId(`workspace-tab-agent_${session.agentId}`);
    await expect(agentTab).toHaveAttribute("aria-selected", "true");

    // Positive control for the in-flight test's absence assertions: a completed
    // turn is exactly where the duration label and copy button do belong.
    await expect(page.getByText(/Worked for/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Copy turn" }).first()).toBeVisible();
    await expect(page.getByTestId("turn-working-indicator")).toHaveCount(0);

    await openAssistantForkMenu(page);
    await page.getByTestId("assistant-fork-menu-new-tab").click();

    const selectedTab = page
      .getByTestId("workspace-tabs-row")
      .getByRole("button")
      .and(page.locator('[aria-selected="true"]'));
    await expect(selectedTab).toHaveAttribute("data-testid", /^workspace-tab-draft_/, {
      timeout: 30_000,
    });
    await expect(agentTab).toHaveAttribute("aria-selected", "false");
    await expectChatHistoryPill(page);

    // The contrast that makes the in-flight test mean something: a completed
    // turn still pins its own boundary. Which field carries it depends on
    // whether the host supports timeline cursors, so assert that the fork was
    // bounded at all rather than picking one field.
    const { request, response } = await forkContext.waitForExchange();
    const requestBoundary =
      ("boundaryCursor" in request ? request.boundaryCursor : null) ??
      ("boundaryMessageId" in request ? request.boundaryMessageId : null);
    expect(requestBoundary ?? null).not.toBeNull();
    expect(response.boundaryCursor ?? response.boundaryMessageId ?? null).not.toBeNull();
  });

  test("keeps the fork attachment after submitting an existing-workspace draft tab", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-tab-submit-",
      title: "Assistant fork tab submit",
      initialPrompt: "emit 1 coalesced agent stream updates for assistant fork tab submit.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await openAssistantForkMenu(page);
    await page.getByTestId("assistant-fork-menu-new-tab").click();
    await expectChatHistoryPill(page);

    await submitMessage(page, "");

    const userMessage = page.getByTestId("user-message").filter({ hasText: "Chat history" }).last();
    await expect(userMessage).toBeVisible({ timeout: 30_000 });
    await expect(userMessage).not.toContainText("Source agent:");
  });

  test("forks an assistant turn into New Workspace and keeps the attachment across host changes", async ({
    page,
    seedForkWorkspace,
  }) => {
    await seedSavedSettingsHosts(page, [
      {
        serverId: getServerId(),
        label: "localhost",
        endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
      },
      {
        serverId: "secondary-assistant-fork-host",
        label: "Secondary host",
        // The host does not need to be reachable; this pins that the draft-scoped
        // attachment survives changing the selected target host.
        endpoint: "127.0.0.1:9",
      },
    ]);

    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-workspace-",
      title: "Assistant fork workspace",
      initialPrompt: "emit 1 coalesced agent stream updates for assistant fork new workspace.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await openAssistantForkMenu(page);
    await page.getByTestId("assistant-fork-menu-new-workspace").click();

    await expect(page).toHaveURL(/\/new\?.*draftId=/, { timeout: 30_000 });
    await expectChatHistoryPill(page);

    await page.getByTestId("host-picker-trigger").click();
    await page
      .getByTestId("new-workspace-host-picker-option-secondary-assistant-fork-host")
      .click();
    await expectChatHistoryPill(page);
  });

  test("keeps the fork attachment after the new agent receives its user message", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-submit-",
      title: "Assistant fork submit",
      initialPrompt: "emit 1 coalesced agent stream updates for assistant fork submit.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await openAssistantForkMenu(page);
    await page.getByTestId("assistant-fork-menu-new-workspace").click();
    await expectChatHistoryPill(page);

    await submitNewWorkspaceEmpty(page);

    const userMessage = page.getByTestId("user-message").filter({ hasText: "Chat history" }).last();
    await expect(userMessage).toBeVisible({ timeout: 30_000 });
    await expect(userMessage).not.toContainText("Source agent:");
  });
});
