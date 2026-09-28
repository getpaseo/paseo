import { expect, test, type Page } from "../support/fixtures";
import { composerLocator, expectComposerVisible, submitMessage } from "../support/helpers/composer";
import { gotoAppShell } from "../support/helpers/app";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  createAgentTabFromMenu,
  waitForWorkspaceTabsVisible,
} from "../support/helpers/workspace-tabs";
import { getServerId } from "../support/helpers/server-id";
import { openNewWorkspaceComposer } from "../support/helpers/new-workspace";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
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

async function runClientSlashCommand(
  page: Page,
  command: "/quit" | "/clear" | "/resume",
): Promise<void> {
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
  test("slash resume opens from a new workspace without submitting a draft", async ({ page }) => {
    const project = await seedWorkspace({ repoPrefix: "slash-resume-new-workspace-" });
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: project.projectKey,
        projectDisplayName: project.projectDisplayName,
      });

      await selectClientSlashCommand(page, "/res", "/resume");
      const sheet = page.getByTestId("import-session-sheet");
      await expect(sheet).toBeVisible();
      await expect(sheet.getByTestId("import-session-scope")).toContainText("Sessions on");
      await expect(page).toHaveURL(/\/new\?/);
      await expect(page.getByTestId("workspace-create-submit")).toBeVisible();
    } finally {
      await project.cleanup();
    }
  });

  test("slash resume opens from a workspace draft without creating an agent", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "slash-resume-draft-" });
    try {
      await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
      await waitForWorkspaceTabsVisible(page);
      await createAgentTabFromMenu(page);
      await expectComposerVisible(page);

      await runClientSlashCommand(page, "/resume");
      const sheet = page.getByTestId("import-session-sheet");
      await expect(sheet).toBeVisible();
      await expect(sheet.getByTestId("import-session-scope")).toContainText("Sessions on");
      await expect(page.locator('[data-testid^="workspace-tab-draft_"]')).toBeVisible();
      await expect(page.locator('[data-testid^="workspace-tab-agent_"]')).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });

  test("slash resume opens the host-wide import picker without archiving the agent", async ({
    page,
  }) => {
    await withOpenReadyMockAgent(page, { title: "Slash resume e2e" }, async ({ agentId }) => {
      await runClientSlashCommand(page, "/resume");
      const sheet = page.getByTestId("import-session-sheet");
      await expect(sheet).toBeVisible();
      await expect(sheet.getByTestId("import-session-scope")).toContainText("Sessions on");
      await expectWorkspaceTabVisible(page, agentId);
    });
  });

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
