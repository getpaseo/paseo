import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expectComposerEditable, submitMessage } from "./composer";
import { connectSeedClient, type SeedDaemonClient } from "./seed-client";
import { getServerId } from "./server-id";

export type RewindFlowProvider = "claude" | "codex" | "opencode" | "pi";
export type RewindFlowMode = "conversation" | "files" | "both";

export interface AgentHandle {
  page: Page;
  client: SeedDaemonClient;
  agentId: string;
  workspaceId: string;
  cwd: string;
  provider: RewindFlowProvider;
}

export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string | RegExp;
}

interface ProviderLaunchConfig {
  provider: RewindFlowProvider;
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  featureValues?: Record<string, unknown>;
}

const SEND_TIMEOUT_MS = 240_000;
const REWIND_TIMEOUT_MS = 120_000;

function fullAccessConfig(provider: RewindFlowProvider): ProviderLaunchConfig {
  switch (provider) {
    case "claude":
      return { provider, model: "haiku", modeId: "bypassPermissions" };
    case "codex":
      return {
        provider,
        model: "gpt-5.4-mini",
        thinkingOptionId: "low",
        modeId: "full-access",
      };
    case "opencode":
      return {
        provider,
        model: "opencode/big-pickle",
        modeId: "build",
        featureValues: { auto_accept: true },
      };
    case "pi":
      return {
        provider,
        model: "openrouter/google/gemini-2.5-flash-lite",
        thinkingOptionId: "medium",
      };
  }
}

function agentRoute(workspaceId: string, agentId: string): string {
  return `${buildHostWorkspaceRoute(getServerId(), workspaceId)}?open=${encodeURIComponent(
    `agent:${agentId}`,
  )}`;
}

async function openAgent(
  page: Page,
  input: { workspaceId: string; agentId: string },
): Promise<void> {
  await page.goto(agentRoute(input.workspaceId, input.agentId));
  await page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 60_000 },
  );
  await assertComposerIdle({ page });
}

function visibleChatMessages(page: Page) {
  return page
    .locator('[data-testid="agent-chat-scroll"]:visible')
    .first()
    .locator('[data-testid="user-message"], [data-testid="assistant-message"]');
}

async function transcript(
  page: Page,
): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
  const rawMessages = await visibleChatMessages(page).evaluateAll((elements) =>
    elements.map((element) => ({
      role: (element.getAttribute("data-testid") === "user-message" ? "user" : "assistant") as
        | "user"
        | "assistant",
      text: (element.textContent ?? "")
        .replace(/\s+/g, " ")
        .replace(/\d{1,2}:\d{2}\s?(?:AM|PM)$/u, "")
        .trim(),
    })),
  );

  return coalesceAssistantTurnSegments(rawMessages);
}

function coalesceAssistantTurnSegments(
  messages: Array<{ role: "user" | "assistant"; text: string }>,
): Array<{ role: "user" | "assistant"; text: string }> {
  const transcriptMessages: Array<{ role: "user" | "assistant"; text: string }> = [];

  for (const message of messages) {
    const previous = transcriptMessages.at(-1);
    if (message.role === "assistant" && previous?.role === "assistant") {
      const joinedText =
        previous.text && message.text
          ? `${previous.text}\n${message.text}`
          : previous.text || message.text;
      transcriptMessages[transcriptMessages.length - 1] = {
        role: "assistant",
        text: joinedText,
      };
      continue;
    }

    transcriptMessages.push(message);
  }

  return transcriptMessages.filter(
    (message) => message.role !== "assistant" || message.text.length > 0,
  );
}

function expectedTextMatches(actual: string, expected: string | RegExp): boolean {
  if (typeof expected === "string") {
    return actual === expected;
  }
  return expected.test(actual);
}

function formatExpectedMessage(message: TranscriptMessage): string {
  const text = typeof message.text === "string" ? JSON.stringify(message.text) : message.text;
  return `${message.role}:${text}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export async function launchAgent(input: {
  page: Page;
  provider: RewindFlowProvider;
  cwd: string;
  mode: "full-access";
}): Promise<AgentHandle> {
  execFileSync("git", ["init", "-b", "main"], { cwd: input.cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "paseo-test@example.com"], {
    cwd: input.cwd,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], {
    cwd: input.cwd,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "commit.gpgsign", "false"], {
    cwd: input.cwd,
    stdio: "ignore",
  });
  writeFileSync(`${input.cwd}/README.md`, "# Paseo rewind flow\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: input.cwd, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: input.cwd, stdio: "ignore" });
  const client = await connectSeedClient();
  const opened = await client.openProject(input.cwd);
  if (!opened.workspace) {
    throw new Error(opened.error ?? `Failed to open project ${input.cwd}`);
  }
  const agent = await client.createAgent({
    ...fullAccessConfig(input.provider),
    cwd: input.cwd,
    workspaceId: opened.workspace.id,
    title: `rewind-flow-${input.provider}-${randomUUID()}`,
  });
  const handle = {
    page: input.page,
    client,
    agentId: agent.id,
    workspaceId: opened.workspace.id,
    cwd: input.cwd,
    provider: input.provider,
  };
  await openAgent(input.page, { workspaceId: opened.workspace.id, agentId: agent.id });
  return handle;
}

export async function closeAgent(handle: AgentHandle): Promise<void> {
  await handle.client.close().catch(() => undefined);
}

export async function sendMessage(handle: AgentHandle, text: string): Promise<void> {
  const before = await transcript(handle.page);
  await submitMessage(handle.page, text);
  const finish = await handle.client.waitForFinish(handle.agentId, SEND_TIMEOUT_MS);
  if (finish.status !== "idle") {
    const suffix = finish.final?.lastError ? `: ${finish.final.lastError}` : "";
    throw new Error(
      `Expected agent ${handle.agentId} to become idle, got ${finish.status}${suffix}`,
    );
  }
  if (finish.final?.lastError) {
    throw new Error(finish.final.lastError);
  }
  await expect
    .poll(async () => transcript(handle.page), { timeout: 30_000 })
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text }),
        expect.objectContaining({ role: "assistant" }),
      ]),
    );
  await expect
    .poll(async () => transcript(handle.page).then((messages) => messages.length), {
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(before.length + 2);
  await assertComposerIdle(handle);
}

export async function assertChatTranscript(
  handle: Pick<AgentHandle, "page">,
  expected: TranscriptMessage[],
): Promise<void> {
  await expect
    .poll(
      async () => {
        const actual = await transcript(handle.page);
        if (actual.length !== expected.length) {
          return JSON.stringify(actual);
        }
        const matches = actual.every(
          (message, index) =>
            message.role === expected[index]?.role &&
            expectedTextMatches(message.text, expected[index]!.text),
        );
        return matches ? "match" : JSON.stringify(actual);
      },
      { timeout: 30_000 },
    )
    .toBe("match");

  const actual = await transcript(handle.page);
  if (actual.length !== expected.length) {
    throw new Error(
      `Expected ${expected.length} chat messages (${expected
        .map(formatExpectedMessage)
        .join(", ")}), found ${actual.length}: ${JSON.stringify(actual)}`,
    );
  }
}

export async function rewindMessage(
  handle: AgentHandle,
  userMessageIndex: number,
  mode: RewindFlowMode,
): Promise<void> {
  const beforeEpoch = await fetchTimelineEpoch(handle);
  const userMessage = handle.page.getByTestId("user-message").nth(userMessageIndex);
  await expect(userMessage).toBeVisible({ timeout: 30_000 });
  const userMessages = (await transcript(handle.page)).filter((message) => message.role === "user");
  const userText = userMessages[userMessageIndex]?.text;
  if (!userText) {
    throw new Error(`No user message found at index ${userMessageIndex}`);
  }
  await userMessage
    .getByText(new RegExp(escapeRegExp(userText)))
    .first()
    .hover();
  const trigger = userMessage.getByTestId("rewind-menu-trigger");
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await trigger.click();
  await expect(handle.page.getByTestId("rewind-menu-content")).toBeVisible({ timeout: 10_000 });
  const modeItem = handle.page.getByTestId(`rewind-menu-${mode}`);
  await expect(modeItem).toBeVisible({ timeout: 10_000 });
  await modeItem.click();
  await expect(handle.page.getByTestId("rewind-menu-content")).toHaveCount(0, { timeout: 10_000 });
  if (mode !== "files") {
    await waitForNextTimelineEpoch(handle, beforeEpoch);
  }
  await assertComposerIdle(handle);
}

export async function assertFileExists(filePath: string): Promise<void> {
  await expect.poll(() => existsSync(filePath), { timeout: 10_000 }).toBe(true);
}

export async function assertFileMissing(filePath: string): Promise<void> {
  await expect.poll(() => existsSync(filePath), { timeout: 10_000 }).toBe(false);
}

export async function assertFileContains(filePath: string, text: string): Promise<void> {
  await assertFileExists(filePath);
  await expect.poll(() => readFileSync(filePath, "utf8"), { timeout: 10_000 }).toContain(text);
}

export async function assertComposerIdle(handle: Pick<AgentHandle, "page">): Promise<void> {
  await expectComposerEditable(handle.page);
  await expect(handle.page.getByRole("button", { name: /stop|cancel/i })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(handle.page.getByTestId("turn-working-indicator")).toHaveCount(0, {
    timeout: 30_000,
  });
}

export async function cleanupRewindFlow(input: {
  handle?: AgentHandle;
  cwd: string;
}): Promise<void> {
  if (input.handle) {
    await closeAgent(input.handle);
  }
  rmSync(input.cwd, { recursive: true, force: true });
}

async function fetchTimelineEpoch(handle: AgentHandle): Promise<string | undefined> {
  const client = handle.client as SeedDaemonClient & {
    fetchAgentTimeline: (
      agentId: string,
      options?: { direction?: "head" | "tail"; projection?: "projected"; limit?: number },
    ) => Promise<{ epoch?: string }>;
  };
  const timeline = await client.fetchAgentTimeline(handle.agentId, {
    direction: "tail",
    projection: "projected",
    limit: 0,
  });
  return timeline.epoch;
}

async function waitForNextTimelineEpoch(
  handle: AgentHandle,
  beforeEpoch: string | undefined,
): Promise<void> {
  await expect
    .poll(async () => fetchTimelineEpoch(handle), { timeout: REWIND_TIMEOUT_MS })
    .not.toBe(beforeEpoch);
}
