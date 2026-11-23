import { expect, test, type Page } from "../support/fixtures";
import { composerLocator, expectComposerVisible, submitMessage } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  expectSessionRowArchived,
  expectWorkspaceTabHidden,
  expectWorkspaceTabVisible,
  openSessions,
} from "../support/helpers/archive-tab";

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

async function typeBeforeMenuFilters(
  page: Page,
  input: { text: string; key: "Tab" | "Enter" },
): Promise<void> {
  await composerLocator(page).evaluate(async (element, { text, key }) => {
    if (!(element instanceof HTMLTextAreaElement)) {
      throw new Error("Composer input is not a textarea");
    }
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setValue) throw new Error("Textarea value setter is unavailable");
    setValue.call(element, text);
    element.setSelectionRange(text.length, text.length);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }, input);
}

async function showExitSuggestion(page: Page, query: string): Promise<void> {
  await composerLocator(page).fill(query);
  await expect(page.getByText("/exit", { exact: true }).first()).toBeVisible();
}

async function expectOpenAgentWithInput(page: Page, agentId: string, text: string): Promise<void> {
  await expect(composerLocator(page)).toHaveValue(text);
  await expectWorkspaceTabVisible(page, agentId);
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

  for (const key of ["Tab", "Enter"] as const) {
    test(`${key} ignores an exit suggestion for an earlier query`, async ({ page }) => {
      await withOpenReadyMockAgent(page, { title: "Stale slash command" }, async ({ agentId }) => {
        await showExitSuggestion(page, "/e");
        await typeBeforeMenuFilters(page, { text: "/co", key });
        await expectOpenAgentWithInput(page, agentId, "/co");
      });
    });
  }

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
