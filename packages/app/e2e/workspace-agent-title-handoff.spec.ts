import { test, expect, type Page } from "./fixtures";
import { expectComposerVisible, submitMessage } from "./helpers/composer";
import { seedWorkspace, type SeedDaemonClient } from "./helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "./helpers/workspace-tabs";
import { captureWsSessionFrames } from "./helpers/rename";
import { getServerId } from "./helpers/server-id";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";

interface WorkspaceTabProbeRecord {
  at: number;
  tabs: Array<{
    testId: string;
    text: string;
    ariaLabel: string;
  }>;
}

interface CapturedCreateAgentFrame {
  initialPrompt: string | null;
  configTitle: string | null;
}

async function installWorkspaceTabProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    type ProbeRecord = WorkspaceTabProbeRecord;
    type ProbeWindow = Window & {
      __workspaceTabTitleProbe?: { records: ProbeRecord[]; stop: () => void };
    };

    const win = window as ProbeWindow;
    win.__workspaceTabTitleProbe?.stop();

    const records: ProbeRecord[] = [];
    const isVisible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    };
    const snapshot = () => {
      records.push({
        at: performance.now(),
        tabs: Array.from(document.querySelectorAll('[data-testid^="workspace-tab-"]'))
          .filter(isVisible)
          .map((element) => ({
            testId: element.getAttribute("data-testid") ?? "",
            text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
            ariaLabel: element.getAttribute("aria-label") ?? "",
          })),
      });
    };

    snapshot();
    const observer = new MutationObserver(snapshot);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "class", "data-testid", "style"],
    });
    const interval = window.setInterval(snapshot, 20);
    win.__workspaceTabTitleProbe = {
      records,
      stop: () => {
        observer.disconnect();
        window.clearInterval(interval);
      },
    };
  });
}

async function readWorkspaceTabProbe(page: Page): Promise<WorkspaceTabProbeRecord[]> {
  return page.evaluate(() => {
    type ProbeWindow = Window & {
      __workspaceTabTitleProbe?: { records: WorkspaceTabProbeRecord[]; stop: () => void };
    };
    const probe = (window as ProbeWindow).__workspaceTabTitleProbe;
    probe?.stop();
    return probe?.records ?? [];
  });
}

function recordHasTabLabel(record: WorkspaceTabProbeRecord, label: string): boolean {
  return record.tabs.some((tab) => tab.text.includes(label) || tab.ariaLabel.includes(label));
}

function createFrameStartsWithPrompt(
  frame: CapturedCreateAgentFrame,
  promptTitle: string,
): boolean {
  return frame.initialPrompt?.startsWith(promptTitle) ?? false;
}

function countCreateFramesForPrompt(
  frames: CapturedCreateAgentFrame[],
  promptTitle: string,
): number {
  return frames.filter((frame) => createFrameStartsWithPrompt(frame, promptTitle)).length;
}

function tabHasLoadingTitle(tab: WorkspaceTabProbeRecord["tabs"][number]): boolean {
  return /Loading agent title|Loading\.\.\./.test(`${tab.text} ${tab.ariaLabel}`);
}

function recordHasLoadingTitle(record: WorkspaceTabProbeRecord): boolean {
  return record.tabs.some(tabHasLoadingTitle);
}

async function waitForCreatedAgentId(client: SeedDaemonClient, cwd: string): Promise<string> {
  await expect
    .poll(
      async () => {
        const result = await client.fetchAgents({ scope: "active" });
        return result.entries
          .filter((entry) => entry.agent.cwd === cwd)
          .map((entry) => entry.agent.id);
      },
      { timeout: 30_000 },
    )
    .toHaveLength(1);
  const result = await client.fetchAgents({ scope: "active" });
  const agent = result.entries.find((entry) => entry.agent.cwd === cwd);
  if (!agent) {
    throw new Error(`Expected one created agent in ${cwd}`);
  }
  return agent.agent.id;
}

async function fetchActiveAgentTitle(
  client: SeedDaemonClient,
  agentId: string,
): Promise<string | null> {
  const result = await client.fetchAgents({ scope: "active" });
  return result.entries.find((entry) => entry.agent.id === agentId)?.agent.title ?? null;
}

async function waitForPromptTabAgentActions(page: Page, promptTitle: string): Promise<void> {
  const promptTab = page.getByRole("button", { name: promptTitle }).first();
  await expect(promptTab).toBeVisible({ timeout: 15_000 });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await promptTab.click({ button: "right" });
    const renameAction = page.getByText("Rename", { exact: true }).first();
    if (await renameAction.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape");
      return;
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(100);
  }

  throw new Error("Prompt tab did not expose agent tab actions after create handoff");
}

test.describe("Workspace agent title handoff", () => {
  test("keeps the prompt as the optimistic tab title until the generated title arrives", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });

    const workspace = await seedWorkspace({ repoPrefix: "workspace-title-handoff-" });

    try {
      const createFrames = captureWsSessionFrames(page, "create_agent_request", (inner) => {
        const config = (inner.config ?? {}) as Record<string, unknown>;
        return {
          initialPrompt: typeof inner.initialPrompt === "string" ? inner.initialPrompt : null,
          configTitle: typeof config.title === "string" ? config.title : null,
        };
      });

      await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
      await waitForWorkspaceTabsVisible(page);
      await page.getByTestId("workspace-new-agent-tab").click();
      await expectComposerVisible(page);

      const promptTitle = "Investigate optimistic tab title handoff";
      const generatedTitle = "Generated Handoff Title";
      await installWorkspaceTabProbe(page);
      await submitMessage(page, `${promptTitle}\n\nMake the UI state deterministic.`);

      const agentId = await waitForCreatedAgentId(workspace.client, workspace.repoPath);
      await expect
        .poll(() => countCreateFramesForPrompt(createFrames, promptTitle), {
          timeout: 10_000,
        })
        .toBe(1);
      expect(createFrames.at(-1)).toEqual({
        initialPrompt: `${promptTitle}\n\nMake the UI state deterministic.`,
        configTitle: null,
      });

      await waitForPromptTabAgentActions(page, promptTitle);

      await workspace.client.updateAgent(agentId, { name: generatedTitle });
      await expect
        .poll(() => fetchActiveAgentTitle(workspace.client, agentId), { timeout: 10_000 })
        .toBe(generatedTitle);
      await expect(page.getByRole("button", { name: generatedTitle }).first()).toBeVisible({
        timeout: 15_000,
      });

      const records = await readWorkspaceTabProbe(page);
      expect(records.some((record) => recordHasTabLabel(record, promptTitle))).toBe(true);
      expect(records.some((record) => recordHasTabLabel(record, generatedTitle))).toBe(true);
      expect(records.filter(recordHasLoadingTitle)).toEqual([]);
    } finally {
      await workspace.cleanup();
    }
  });
});
