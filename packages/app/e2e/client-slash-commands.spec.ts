import { expect, test, type Page } from "./fixtures";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { composerLocator, expectComposerVisible, submitMessage } from "./helpers/composer";
import { expectAgentIdle } from "./helpers/agent-stream";
import { connectTerminalClient, type TerminalPerfDaemonClient } from "./helpers/terminal-perf";
import { createTempGitRepo } from "./helpers/workspace";
import {
  expectSessionRowArchived,
  expectWorkspaceTabHidden,
  expectWorkspaceTabVisible,
  openSessions,
} from "./helpers/archive-tab";

interface SlashCommandScenario {
  agent: { id: string };
  client: TerminalPerfDaemonClient;
  cwd: string;
  title: string;
}

const REPLACEMENT_PROMPT = "Replacement prompt after slash clear.";

function getServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set.");
  }
  return serverId;
}

async function withOpenReadyMockAgent(
  page: Page,
  input: {
    title: string;
    model?: string;
    modeId?: string;
  },
  run: (scenario: SlashCommandScenario) => Promise<void>,
): Promise<void> {
  const repo = await createTempGitRepo("client-slash-command-");
  const client = await connectTerminalClient();

  try {
    await installCreateAgentRequestRecorder(page);
    await openProject(client, repo.path);
    const agent = await createReadyMockAgent(client, {
      cwd: repo.path,
      title: input.title,
      model: input.model,
      modeId: input.modeId,
    });
    await openActiveAgentTab(page, { cwd: repo.path, agentId: agent.id });

    await run({ agent, client, cwd: repo.path, title: input.title });
  } finally {
    await client.close();
    await repo.cleanup();
  }
}

async function installCreateAgentRequestRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const requests: unknown[] = [];
    (
      window as typeof window & {
        __paseoE2eCreateAgentRequests?: unknown[];
      }
    ).__paseoE2eCreateAgentRequests = requests;
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string") {
        try {
          const parsed = JSON.parse(data) as {
            type?: unknown;
            message?: { type?: unknown };
          };
          if (parsed.type === "session" && parsed.message?.type === "create_agent_request") {
            requests.push(parsed.message);
          }
        } catch {
          // Ignore non-JSON frames.
        }
      }
      return originalSend.call(this, data);
    };
  });
}

async function openProject(client: TerminalPerfDaemonClient, cwd: string): Promise<void> {
  const opened = await client.openProject(cwd);
  if (!opened.workspace) {
    throw new Error(opened.error ?? `Failed to open project ${cwd}`);
  }
}

async function createReadyMockAgent(
  client: TerminalPerfDaemonClient,
  input: {
    cwd: string;
    title: string;
    model?: string;
    modeId?: string;
  },
): Promise<{ id: string }> {
  const agent = await client.createAgent({
    provider: "mock",
    cwd: input.cwd,
    title: input.title,
    modeId: input.modeId ?? "load-test",
    model: input.model ?? "ten-second-stream",
    initialPrompt: "Prepare a client slash command test agent.",
  });
  return { id: agent.id };
}

async function openActiveAgentTab(
  page: Page,
  input: { cwd: string; agentId: string },
): Promise<void> {
  const agentUrl = `${buildHostWorkspaceRoute(
    getServerId(),
    input.cwd,
  )}?open=${encodeURIComponent(`agent:${input.agentId}`)}`;
  await page.goto(agentUrl);
  await page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 60_000 },
  );
  await expectWorkspaceTabVisible(page, input.agentId);
  await expectComposerVisible(page);
  await expectAgentIdle(page, 30_000);
}

async function runClientSlashCommand(page: Page, command: "/quit" | "/clear"): Promise<void> {
  const input = composerLocator(page);
  await expect(input).toBeEditable({ timeout: 30_000 });
  await input.fill(command);
  await expect(input).toHaveValue(command);
  await input.press("Enter");
}

async function expectAgentArchivedInSessions(page: Page, title: string): Promise<void> {
  await openSessions(page);
  await expectSessionRowArchived(page, title);
}

async function expectSeededDraftReady(page: Page): Promise<void> {
  await expectComposerVisible(page);
}

async function createAgentFromSeededDraft(page: Page): Promise<void> {
  await submitMessage(page, REPLACEMENT_PROMPT);
}

async function expectReplacementAgentMatchesSetup(input: {
  page: Page;
  oldAgentId: string;
  cwd: string;
  provider: string;
  model: string;
  modeId: string;
}): Promise<void> {
  await waitForReplacementAgentId(input.page, input.oldAgentId);
  await expect
    .poll(async () => getRecordedReplacementCreateConfig(input.page), { timeout: 30_000 })
    .toEqual({
      cwd: input.cwd,
      modeId: input.modeId,
      model: input.model,
      provider: input.provider,
    });
}

async function getRecordedReplacementCreateConfig(page: Page): Promise<{
  cwd?: string;
  modeId?: string;
  model?: string;
  provider?: string;
} | null> {
  return page.evaluate((expectedPrompt) => {
    const requests =
      (
        window as typeof window & {
          __paseoE2eCreateAgentRequests?: Array<{
            initialPrompt?: string;
            config?: { cwd?: string; modeId?: string; model?: string; provider?: string };
          }>;
        }
      ).__paseoE2eCreateAgentRequests ?? [];

    const request = requests.find((candidate) => candidate.initialPrompt === expectedPrompt);
    return request?.config ?? null;
  }, REPLACEMENT_PROMPT);
}

async function waitForReplacementAgentId(page: Page, oldAgentId: string): Promise<string> {
  let newAgentId: string | null = null;
  await expect
    .poll(
      async () => {
        const ids = await page
          .locator('[data-testid^="workspace-tab-agent_"]')
          .evaluateAll((nodes) =>
            nodes.flatMap((node) => {
              if (!(node instanceof HTMLElement)) {
                return [];
              }
              const testId = node.getAttribute("data-testid") ?? "";
              if (!testId.startsWith("workspace-tab-agent_")) {
                return [];
              }
              if (node.offsetParent === null) {
                return [];
              }
              return [testId.slice("workspace-tab-agent_".length)];
            }),
          );
        newAgentId = ids.find((id) => id !== oldAgentId) ?? null;
        return newAgentId;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();
  if (!newAgentId) {
    throw new Error("Replacement agent was not created.");
  }
  return newAgentId;
}

test.describe("Client slash commands", () => {
  test("slash quit archives the active agent and removes its tab", async ({ page }) => {
    await withOpenReadyMockAgent(page, { title: "Slash quit e2e" }, async ({ agent, title }) => {
      await runClientSlashCommand(page, "/quit");
      await expectWorkspaceTabHidden(page, agent.id);
      await expectAgentArchivedInSessions(page, title);
    });
  });

  test("slash clear replaces the active agent with a seeded draft", async ({ page }) => {
    await withOpenReadyMockAgent(
      page,
      { title: "Slash clear e2e", model: "ten-second-stream", modeId: "load-test" },
      async ({ agent, cwd, title }) => {
        await runClientSlashCommand(page, "/clear");
        await expectWorkspaceTabHidden(page, agent.id);
        await expectSeededDraftReady(page);
        await createAgentFromSeededDraft(page);
        await expectReplacementAgentMatchesSetup({
          page,
          oldAgentId: agent.id,
          cwd,
          provider: "mock",
          model: "ten-second-stream",
          modeId: "load-test",
        });
        await expectAgentArchivedInSessions(page, title);
      },
    );
  });
});
