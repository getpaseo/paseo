import { expect, test, type Page } from "../support/fixtures";
import { composerLocator, expectComposerVisible, submitMessage } from "../support/helpers/composer";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  expectSessionRowArchived,
  expectWorkspaceTabHidden,
  expectWorkspaceTabVisible,
  openSessions,
} from "../support/helpers/archive-tab";

interface SlashCommandScenario {
  agentId: string;
  title: string;
  client: MockAgentWorkspace["client"];
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

    await run({ agentId: session.agentId, title: input.title, client: session.client });
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

async function failTemplateLookupUntilRecovery(page: Page): Promise<() => void> {
  let failing = true;
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (typeof message !== "string") {
        server.send(message);
        return;
      }
      const envelope = JSON.parse(message) as {
        type?: string;
        agentId?: string;
        message?: { type?: string; agentId?: string };
      };
      const request = envelope.message ?? envelope;
      if (failing && request.type === "agent.template.get.request") {
        // Exercise the real daemon's failure response and request correlation.
        request.agentId = "missing-clear-template-source";
        server.send(JSON.stringify(envelope));
        return;
      }
      server.send(message);
    });
  });
  return () => {
    failing = false;
  };
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
  test("slash clear awaits a fresh template before hiding or archiving the original tab", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const gate = await installDaemonWebSocketGate(page);
    await withOpenReadyMockAgent(
      page,
      { title: "Slash clear fresh template", model: "ten-second-stream", modeId: "load-test" },
      async ({ agentId, title, client }) => {
        await client.waitForFinish(agentId, 45_000);
        const sourceTab = page.getByTestId(`workspace-tab-agent_${agentId}`);
        await expect(sourceTab).toHaveAttribute("aria-selected", "true");
        await expectReplacementDraftMatchesPreviousSetup(page);
        const sourceUrl = page.url();
        gate.holdNextClientRequest("agent.template.get.request");

        await runClientSlashCommand(page, "/clear");
        await gate.waitForHeldClientRequest();

        await expect(page).toHaveURL(sourceUrl);
        await expect(sourceTab).toHaveAttribute("aria-selected", "true");
        await expect(page.locator('[data-testid^="workspace-tab-draft_"]')).toHaveCount(0);
        await expect(composerLocator(page)).toHaveValue("/clear");
        expect(await client.fetchAgent({ agentId })).toMatchObject({ agent: { archivedAt: null } });

        // The template must read this update, not the setup captured before awaiting.
        await client.setAgentMode(agentId, "approval-test");
        gate.releaseHeldClientRequest();

        await expectWorkspaceTabHidden(page, agentId);
        await expectComposerVisible(page);
        await expect(
          page.getByRole("button", { name: "Select model (Ten second stream)" }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Select agent mode (Approval test)" }),
        ).toBeVisible();
        await createAgentFromReplacementDraft(page);
        await waitForReplacementAgentId(page, agentId);
        await expectAgentArchivedInSessions(page, title);
      },
    );
  });

  test("slash clear keeps the original tab, command draft and archive state on template failure", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const allowRecovery = await failTemplateLookupUntilRecovery(page);
    await withOpenReadyMockAgent(
      page,
      { title: "Slash clear template failure", model: "ten-second-stream", modeId: "load-test" },
      async ({ agentId, title, client }) => {
        await client.waitForFinish(agentId, 45_000);
        const sourceTab = page.getByTestId(`workspace-tab-agent_${agentId}`);
        await expect(sourceTab).toHaveAttribute("aria-selected", "true");
        const sourceUrl = page.url();

        await runClientSlashCommand(page, "/clear");

        const error = page
          .getByRole("alert")
          .filter({ hasText: "Agent not found: missing-clear-template-source" });
        await expect(error).toBeVisible();
        await expect(error).toContainText(/retry|try again/i);
        await expect(page).toHaveURL(sourceUrl);
        await expect(sourceTab).toHaveAttribute("aria-selected", "true");
        await expect(page.locator('[data-testid^="workspace-tab-draft_"]')).toHaveCount(0);
        await expect(composerLocator(page)).toBeEditable();
        await expect(composerLocator(page)).toHaveValue("/clear");
        expect(await client.fetchAgent({ agentId })).toMatchObject({ agent: { archivedAt: null } });
        await expect(error).toBeVisible();

        allowRecovery();
        await composerLocator(page).press("Enter");
        await expectWorkspaceTabHidden(page, agentId);
        await expectReplacementDraftMatchesPreviousSetup(page);
        await expect(error).toHaveCount(0);
        await createAgentFromReplacementDraft(page);
        await waitForReplacementAgentId(page, agentId);
        await expectAgentArchivedInSessions(page, title);
      },
    );
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
