import { expect, test, type Page } from "./fixtures";
import { composerLocator, expectComposerVisible, submitMessage } from "./helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";
import {
  expectSessionRowArchived,
  expectWorkspaceTabHidden,
  expectWorkspaceTabVisible,
  openSessions,
} from "./helpers/archive-tab";

interface SlashCommandScenario {
  agentId: string;
  title: string;
}

const REPLACEMENT_PROMPT = "Replacement prompt after slash clear.";

async function withOpenReadyMockAgent(
  page: Page,
  input: {
    title: string;
    model?: string;
    modeId?: string;
  },
  run: (scenario: SlashCommandScenario) => Promise<void>,
): Promise<void> {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "client-slash-command-",
    title: input.title,
    model: input.model,
    modeId: input.modeId,
    initialPrompt: "Prepare a client slash command test agent.",
  });

  try {
    await openAgentRoute(page, session);
    await expectWorkspaceTabVisible(page, session.agentId);
    await expectComposerVisible(page);

    await run({ agentId: session.agentId, title: input.title });
  } finally {
    await session.cleanup();
  }
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
    await withOpenReadyMockAgent(page, { title: "Slash quit e2e" }, async ({ agentId, title }) => {
      await runClientSlashCommand(page, "/quit");
      await expectWorkspaceTabHidden(page, agentId);
      await expectAgentArchivedInSessions(page, title);
    });
  });

  test("slash quit selected from autocomplete archives immediately", async ({ page }) => {
    await withOpenReadyMockAgent(
      page,
      { title: "Slash quit autocomplete e2e" },
      async ({ agentId, title }) => {
        await selectClientSlashCommand(page, "/qu", "/exit");
        await expectWorkspaceTabHidden(page, agentId);
        await expectAgentArchivedInSessions(page, title);
      },
    );
  });

  test("slash clear replaces the active agent with a matching draft", async ({ page }) => {
    await withOpenReadyMockAgent(
      page,
      { title: "Slash clear e2e", model: "ten-second-stream", modeId: "load-test" },
      async ({ agentId, title }) => {
        await runClientSlashCommand(page, "/clear");
        await expectWorkspaceTabHidden(page, agentId);
        await expectReplacementDraftMatchesPreviousSetup(page);
        await createAgentFromReplacementDraft(page);
        await waitForReplacementAgentId(page, agentId);
        await expectAgentArchivedInSessions(page, title);
      },
    );
  });
});
