import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./fixtures";
import {
  assertChatTranscript,
  assertComposerIdle,
  cleanupRewindFlow,
  launchAgent,
  sendMessage,
  type AgentHandle,
  type TranscriptMessage,
} from "./helpers/rewind-flow";
import type { SeedDaemonClient } from "./helpers/seed-client";

/**
 * Verifies the "Fork session" tab action end-to-end against a real Claude
 * session: the SDK's full-copy forkSession() actually runs, the new agent lands
 * in a tab immediately to the right of its source, the fork starts with the
 * whole transcript, and the two sessions then diverge without bleeding into
 * each other.
 */

const SHOT_DIR = process.env.FORK_SHOT_DIR ?? "/tmp/paseo-fork-verification";

const CODEWORD = "ZEPHYRLOOM";
const SECOND_WORD = "MARBLEFINCH";
const MEMORY_PROMPT = `Remember this codeword: ${CODEWORD}. Reply with just the word "stored".`;
const SECOND_PROMPT = `Remember a second codeword: ${SECOND_WORD}. Reply with just the word "stored".`;
const RECALL_PROMPT =
  "List both codewords I asked you to remember, in order, separated by a space. Reply with only those two words.";
const SOURCE_MARKER = "TANGERINEHOLLOW";
const SOURCE_PROMPT = `Reply with only this word: ${SOURCE_MARKER}`;

/** The two exchanges the fork is expected to inherit verbatim. */
const BASE_TRANSCRIPT: TranscriptMessage[] = [
  { role: "user", text: MEMORY_PROMPT },
  { role: "assistant", text: /.+/ },
  { role: "user", text: SECOND_PROMPT },
  { role: "assistant", text: /.+/ },
];

/** How long to hold the open menu on screen, so the recording is watchable. */
const MENU_HOLD_MS = 2_000;

/**
 * Wait until an element is fully opaque. The tab context menu fades in, so
 * screenshotting as soon as it is "visible" catches it mid-animation and the
 * chat behind it bleeds through. Opacity is inherited multiplicatively, so this
 * walks the ancestor chain rather than reading the element alone.
 */
async function waitForOpaque(target: Locator): Promise<void> {
  await expect
    .poll(
      () =>
        target.evaluate((element) => {
          let opacity = 1;
          let node: HTMLElement | null = element as HTMLElement;
          while (node) {
            opacity *= Number(globalThis.getComputedStyle(node).opacity || "1");
            node = node.parentElement;
          }
          return Number(opacity.toFixed(3));
        }),
      { timeout: 10_000 },
    )
    .toBe(1);
}

let shotIndex = 0;

async function shot(page: Page, name: string): Promise<void> {
  shotIndex += 1;
  const file = path.join(SHOT_DIR, `${String(shotIndex).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`[fork-verify] screenshot: ${file}`);
}

/**
 * Whether an agent's own timeline contains a piece of text, straight from the
 * daemon. Rendered chat text cannot answer "which session ran this turn": the
 * source and the fork share a transcript prefix, so they answer identically.
 * Only the per-agent timeline distinguishes them.
 */
async function timelineContains(
  handle: AgentHandle,
  agentId: string,
  needle: string,
): Promise<boolean> {
  const client = handle.client as SeedDaemonClient & {
    fetchAgentTimeline: (
      agentId: string,
      options?: { direction?: "tail"; projection?: "projected"; limit?: number },
    ) => Promise<{ entries: unknown[] }>;
  };
  const timeline = await client.fetchAgentTimeline(agentId, {
    direction: "tail",
    projection: "projected",
    limit: 200,
  });
  return JSON.stringify(timeline.entries).includes(needle);
}

/** The model and mode the daemon reports for an agent. */
async function agentRuntimeConfig(
  handle: AgentHandle,
  agentId: string,
): Promise<{ model: string | null; currentModeId: string | null }> {
  const agents = await handle.client.fetchAgents({ scope: "active" });
  const entry = agents.entries.find((candidate) => candidate.agent.id === agentId);
  if (!entry) {
    throw new Error(`Agent ${agentId} not found in the daemon's active agents`);
  }
  return { model: entry.agent.model, currentModeId: entry.agent.currentModeId };
}

/** Agent tab ids in left-to-right DOM order. */
async function agentTabOrder(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="workspace-tab-agent_"]')
    .evaluateAll((elements) =>
      elements.map((element) =>
        (element.getAttribute("data-testid") ?? "").replace("workspace-tab-agent_", ""),
      ),
    );
}

test.describe("fork session - claude", () => {
  test.setTimeout(900_000);

  test("forks a real Claude session into a new tab to the right", async ({ page }) => {
    mkdirSync(SHOT_DIR, { recursive: true });
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-fork-session-claude-")));
    let handle: AgentHandle | undefined;

    try {
      handle = await launchAgent({ page, provider: "claude", cwd, mode: "full-access" });

      // 1. Give the source session a multi-turn transcript worth copying. Two
      //    exchanges, so "full copy" is distinguishable from rewind's slice.
      await sendMessage(handle, MEMORY_PROMPT);
      await sendMessage(handle, SECOND_PROMPT);
      await assertChatTranscript(handle, BASE_TRANSCRIPT);
      await shot(page, "source-session-with-transcript");

      // 2. The Fork session entry is present on the source tab's context menu.
      const sourceTab = page.getByTestId(`workspace-tab-agent_${handle.agentId}`).first();
      await sourceTab.click({ button: "right" });
      const menu = page.getByTestId(`workspace-tab-context-agent_${handle.agentId}`);
      await expect(menu).toBeVisible({ timeout: 10_000 });
      const forkItem = page.getByTestId(
        `workspace-tab-context-agent_${handle.agentId}-fork-session`,
      );
      // Let the fade-in finish before capturing, otherwise the menu is caught
      // half-transparent with the chat showing through it.
      await waitForOpaque(menu);
      await page.waitForTimeout(MENU_HOLD_MS);
      // Screenshot the open menu before asserting, so a missing entry is
      // captured as evidence instead of only showing up as a bare timeout.
      await shot(page, "fork-session-menu-entry");
      await expect(forkItem).toBeVisible({ timeout: 10_000 });
      // Hold the fully drawn menu on screen so the recording reads clearly
      // before the click lands.
      await page.waitForTimeout(MENU_HOLD_MS);

      // 3. Fork. The daemon calls the Claude SDK's forkSession() for real here.
      const tabsBefore = await agentTabOrder(page);
      await forkItem.click();

      await expect
        .poll(async () => (await agentTabOrder(page)).length, { timeout: 180_000 })
        .toBeGreaterThan(tabsBefore.length);

      const tabsAfter = await agentTabOrder(page);
      const sourceIndex = tabsAfter.indexOf(handle.agentId);
      expect(sourceIndex, "source tab still present after fork").toBeGreaterThanOrEqual(0);
      const forkedAgentId = tabsAfter[sourceIndex + 1];
      if (!forkedAgentId) {
        throw new Error(
          `Expected a forked tab directly right of the source. Order: ${JSON.stringify(tabsAfter)}`,
        );
      }
      expect(forkedAgentId).not.toBe(handle.agentId);
      expect(tabsBefore).not.toContain(forkedAgentId);
      console.log(`[fork-verify] source=${handle.agentId} forked=${forkedAgentId}`);

      const forkHandle: AgentHandle = { ...handle, agentId: forkedAgentId };

      // 3b. The forked tab must be ACTIVE, not merely present. Under the
      //     original bug the tab was pruned as stale and re-added appended and
      //     unfocused, so a presence check passes on broken code. Hold the
      //     assertion across a few reconcile cycles: the failure signature is
      //     appear → vanish → reappear in the wrong slot.
      const activeForkTab = page.locator(
        `[data-testid="workspace-tab-agent_${forkedAgentId}"][aria-selected="true"]`,
      );
      await expect(activeForkTab).toHaveCount(1, { timeout: 30_000 });
      for (let cycle = 0; cycle < 3; cycle += 1) {
        await page.waitForTimeout(1_000);
        await expect(activeForkTab, `fork tab lost focus on reconcile cycle ${cycle}`).toHaveCount(
          1,
        );
      }

      // 3c. The fork continues the source conversation, so it must keep running
      //     it the same way. Falling back to provider defaults would silently
      //     move the user onto a different model and permission mode — a cost
      //     and safety change they never asked for.
      const sourceConfig = await agentRuntimeConfig(handle, handle.agentId);
      await expect
        .poll(() => agentRuntimeConfig(handle!, forkedAgentId), { timeout: 30_000 })
        .toEqual(sourceConfig);

      // 4. The forked tab is focused and holds a full copy of both exchanges.
      await assertComposerIdle({ page });
      await assertChatTranscript(forkHandle, BASE_TRANSCRIPT);
      await shot(page, "forked-tab-holds-transcript-copy");

      // 5. Send a turn from the forked tab. NOTE: a passing assertion here does
      //    not by itself prove the fork is live — if the pane is still bound to
      //    the source agent the turn runs on the source session, which has the
      //    same context and answers identically. Step 6 is what disambiguates:
      //    if this turn landed on the source, it shows up in the source's
      //    transcript there.
      await sendMessage(forkHandle, RECALL_PROMPT);
      await assertChatTranscript(forkHandle, [
        ...BASE_TRANSCRIPT,
        { role: "user", text: RECALL_PROMPT },
        { role: "assistant", text: new RegExp(`${CODEWORD}[\\s\\S]*${SECOND_WORD}`, "i") },
      ]);
      await shot(page, "fork-recalls-inherited-context");

      // 5b. Daemon truth — the assertion that actually pins the routing. The
      //     turn must have executed on the FORKED agent and must NOT appear in
      //     the source's timeline. Without this, a fork that silently drives the
      //     source session passes every UI assertion above, because the source
      //     holds the same context and answers identically.
      await expect
        .poll(() => timelineContains(handle!, forkedAgentId, RECALL_PROMPT), { timeout: 30_000 })
        .toBe(true);
      expect(
        await timelineContains(handle, handle.agentId, RECALL_PROMPT),
        "source session must not absorb a turn sent from the forked tab",
      ).toBe(false);

      // 6. The source session is untouched by the fork's turn. Close the forked
      //    tab first: with both agent tabs open only one chat scroll is
      //    rendered, so the source pane has to be the only one left to read.
      await page.getByTestId(`workspace-agent-close-${forkedAgentId}`).first().click();
      await expect
        .poll(async () => (await agentTabOrder(page)).includes(forkedAgentId), { timeout: 30_000 })
        .toBe(false);
      await assertComposerIdle({ page });
      await assertChatTranscript(handle, BASE_TRANSCRIPT);
      await shot(page, "source-unchanged-by-fork");

      // 7. The source keeps running on its own session and diverges from the
      //    fork point. The fork's recall turn never appears here.
      await sendMessage(handle, SOURCE_PROMPT);
      await assertChatTranscript(handle, [
        ...BASE_TRANSCRIPT,
        { role: "user", text: SOURCE_PROMPT },
        { role: "assistant", text: new RegExp(SOURCE_MARKER, "i") },
      ]);
      const sourceTranscript = await page
        .locator('[data-testid="agent-chat-scroll"]:visible')
        .first()
        .innerText();
      expect(sourceTranscript).not.toContain(RECALL_PROMPT);
      await shot(page, "source-diverges-independently");
    } finally {
      await cleanupRewindFlow({ handle, cwd });
    }
  });
});
