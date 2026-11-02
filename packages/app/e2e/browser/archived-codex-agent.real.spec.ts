import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "../support/fixtures";
import type { Page } from "@playwright/test";
import {
  clickSessionRow,
  closeWorkspaceAgentTab,
  expectSessionRowArchived,
  expectSessionRowNotArchived,
  openSessions,
} from "../support/helpers/archive-tab";
import { expectComposerEditable } from "../support/helpers/composer";
import {
  assertChatTranscript,
  cleanupRewindFlow,
  launchAgent,
  sendMessage,
  type AgentHandle,
} from "../support/helpers/rewind-flow";
import type { SeedDaemonClient } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

interface TimelineClient extends SeedDaemonClient {
  fetchAgentTimeline(
    agentId: string,
    options: { direction: "tail"; projection: "projected"; limit: number },
  ): Promise<unknown>;
}

const INITIAL_PROMPT = "Reply with exactly CODEX_ARCHIVE_TIMELINE_SENTINEL and nothing else.";
const INITIAL_REPLY = "CODEX_ARCHIVE_TIMELINE_SENTINEL";
const FOLLOW_UP_PROMPT = "Reply with exactly CODEX_UNARCHIVED_SENTINEL and nothing else.";
const FOLLOW_UP_REPLY = "CODEX_UNARCHIVED_SENTINEL";

async function historyContainsAgent(client: SeedDaemonClient, agentId: string): Promise<boolean> {
  const history = await client.fetchAgentHistory({ page: { limit: 200 } });
  return history.entries.some((entry) => entry.agent.id === agentId);
}

async function closeAgentTab(page: Page, agentId: string): Promise<void> {
  await page
    .getByTestId(`workspace-tab-agent_${agentId}`)
    .filter({ visible: true })
    .first()
    .hover();
  await closeWorkspaceAgentTab(page, agentId);
}

async function unarchiveOpenAgent(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Unarchive", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unarchive", exact: true })).toHaveCount(0, {
    timeout: 60_000,
  });
  await expectComposerEditable(page);
}

test.describe("archived Codex agent recovery", () => {
  test.setTimeout(600_000);

  test("cold-opens without provider history, then unarchives and restores the conversation", async ({
    page,
  }) => {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-archived-codex-")));
    let handle: AgentHandle | undefined;

    try {
      handle = await launchAgent({
        page,
        provider: "codex",
        cwd,
        mode: "full-access",
      });
      await sendMessage(handle, INITIAL_PROMPT);
      await assertChatTranscript(handle, [
        { role: "user", text: INITIAL_PROMPT },
        { role: "assistant", text: INITIAL_REPLY },
      ]);

      await handle.client.archiveAgent(handle.agentId);
      await expect
        .poll(
          async () =>
            (await handle?.client.fetchAgent({ agentId: handle.agentId }))?.agent.archivedAt ??
            null,
          { timeout: 30_000 },
        )
        .not.toBeNull();

      const timelineClient = handle.client as TimelineClient;
      await expect(
        timelineClient.fetchAgentTimeline(handle.agentId, {
          direction: "tail",
          projection: "projected",
          limit: 100,
        }),
      ).rejects.toThrow(/archiv/i);
      await expect
        .poll(async () => (handle ? historyContainsAgent(handle.client, handle.agentId) : false), {
          timeout: 30_000,
        })
        .toBe(true);

      await page.reload();
      await waitForSidebarHydration(page);
      await openSessions(page);
      await page.getByTestId(`agent-row-${getServerId()}-${handle.agentId}`).click();

      await expect(
        page.getByTestId(`workspace-tab-agent_${handle.agentId}`).filter({ visible: true }).first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("This agent is archived", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("agent-load-error")).toHaveCount(0);
      await expect(page.getByTestId("agent-timeline-sync-error")).toHaveCount(0);
      await expect(page.getByTestId("user-message")).toHaveCount(0);

      await page.getByRole("button", { name: "Unarchive" }).click();
      await expect(page.getByRole("button", { name: "Unarchive" })).toHaveCount(0, {
        timeout: 60_000,
      });
      await assertChatTranscript(handle, [
        { role: "user", text: INITIAL_PROMPT },
        { role: "assistant", text: INITIAL_REPLY },
      ]);

      await sendMessage(handle, FOLLOW_UP_PROMPT);
      await assertChatTranscript(handle, [
        { role: "user", text: INITIAL_PROMPT },
        { role: "assistant", text: INITIAL_REPLY },
        { role: "user", text: FOLLOW_UP_PROMPT },
        { role: "assistant", text: FOLLOW_UP_REPLY },
      ]);
    } finally {
      await cleanupRewindFlow({ handle, cwd });
    }
  });

  test("refreshes cached History after unarchiving without restarting", async ({ page }) => {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-unarchive-history-")));
    let handle: AgentHandle | undefined;
    try {
      handle = await launchAgent({
        page,
        provider: "codex",
        providerConfig: { model: "gpt-5.6-sol" },
        cwd,
        mode: "full-access",
      });
      await sendMessage(handle, INITIAL_PROMPT);
      await assertChatTranscript(handle, [
        { role: "user", text: INITIAL_PROMPT },
        { role: "assistant", text: INITIAL_REPLY },
      ]);
      await closeAgentTab(page, handle.agentId);
      await openSessions(page);
      await expectSessionRowArchived(page, "rewind-flow-codex-");
      await clickSessionRow(page, "rewind-flow-codex-");
      await unarchiveOpenAgent(page);
      await openSessions(page);
      await expectSessionRowNotArchived(page, "rewind-flow-codex-");
      await clickSessionRow(page, "rewind-flow-codex-");
      await expectComposerEditable(page);
    } finally {
      await cleanupRewindFlow({ handle, cwd });
    }
  });
});
