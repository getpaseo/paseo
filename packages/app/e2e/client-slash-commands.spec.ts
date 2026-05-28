import { expect, test, type Page } from "./fixtures";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { composerLocator, expectComposerVisible, submitMessage } from "./helpers/composer";
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
}

async function runClientSlashCommand(page: Page, command: "/quit" | "/clear"): Promise<void> {
  const input = composerLocator(page);
  await expect(input).toBeEditable({ timeout: 30_000 });
  await input.fill(command);
  await expect(input).toHaveValue(command);
  await input.press("Enter");
}

async function selectClientSlashCommand(page: Page, query: string, label: string): Promise<void> {
  const input = composerLocator(page);
  await expect(input).toBeEditable({ timeout: 30_000 });
  await input.fill(query);
  await expect(page.getByText(label, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await input.press("Enter");
}

async function expectAgentArchivedInSessions(page: Page, title: string): Promise<void> {
  await openSessions(page);
  await expectSessionRowArchived(page, title);
}

async function expectReplacementDraftMatchesPreviousSetup(page: Page): Promise<void> {
  await expectComposerVisible(page);
  await expect(
    page.getByRole("button", { name: "Select model (Ten second stream)" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Select agent mode (Load test)" })).toBeVisible();
}

async function createAgentFromReplacementDraft(page: Page): Promise<void> {
  await submitMessage(page, REPLACEMENT_PROMPT);
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

  test("slash quit selected from autocomplete archives immediately", async ({ page }) => {
    await withOpenReadyMockAgent(
      page,
      { title: "Slash quit autocomplete e2e" },
      async ({ agent, title }) => {
        await selectClientSlashCommand(page, "/qu", "/exit");
        await expectWorkspaceTabHidden(page, agent.id);
        await expectAgentArchivedInSessions(page, title);
      },
    );
  });

  test("slash clear replaces the active agent with a matching draft", async ({ page }) => {
    await withOpenReadyMockAgent(
      page,
      { title: "Slash clear e2e", model: "ten-second-stream", modeId: "load-test" },
      async ({ agent, title }) => {
        await runClientSlashCommand(page, "/clear");
        await expectWorkspaceTabHidden(page, agent.id);
        await expectReplacementDraftMatchesPreviousSetup(page);
        await createAgentFromReplacementDraft(page);
        await waitForReplacementAgentId(page, agent.id);
        await expectAgentArchivedInSessions(page, title);
      },
    );
  });
});
