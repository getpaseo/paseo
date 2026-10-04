import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { expectComposerVisible } from "./composer";
import { openAgentRoute, seedMockAgentWorkspace } from "./mock-agent";
import { installUsageReportsFixture, type UsageListResponse } from "./usage-reports";
import { claudeAndCodexReports } from "./usage-sidebar-item";

// 32,000 of the mock's 128,000-token window.
const METER_NAME = "Context window 25% used";

export type MockAgentSession = Awaited<ReturnType<typeof seedMockAgentWorkspace>>;

/** An agent a quarter into its context window. */
export function seedAgentWithContextWindow(): Promise<MockAgentSession> {
  return seedMockAgentWorkspace({
    repoPrefix: "context-window-usage-",
    title: "Context window usage e2e",
    initialPrompt: "emit 32000 byte file agent stream payload",
  });
}

export async function openAgent(page: Page, session: MockAgentSession): Promise<void> {
  await openAgentRoute(page, session);
  await expectComposerVisible(page);
}

export async function reloadAgent(page: Page): Promise<void> {
  await page.reload({ waitUntil: "commit" });
  await expectComposerVisible(page);
}

/** Wide screens show the meter's details in a hover card while the pointer is on it. */
export async function hoverContextWindowMeter(page: Page, name = METER_NAME): Promise<Locator> {
  await page.getByRole("img", { name, exact: true }).hover({ timeout: 30_000 });
  const card = contextWindowDetails(page);
  await expect(card).toBeVisible();
  return card;
}

/** Walks the pointer from the meter up onto its hover card, across the gap between them. */
export async function moveOntoContextWindowDetails(page: Page, card: Locator): Promise<void> {
  const meter = await page.getByRole("img", { name: METER_NAME }).boundingBox();
  const box = await card.boundingBox();
  if (!meter || !box) throw new Error("The meter and its hover card must be on screen.");
  await page.mouse.move(meter.x + meter.width / 2, box.y + box.height / 2, { steps: 20 });
}

export async function leaveContextWindowMeter(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await expect(contextWindowDetails(page)).toHaveCount(0);
}

/** Compact screens open the meter's details in a sheet. */
export async function pressContextWindowMeter(page: Page, name = METER_NAME): Promise<Locator> {
  await page.getByRole("button", { name, exact: true }).click({ timeout: 30_000 });
  const sheet = contextWindowDetails(page);
  await expect(sheet).toBeVisible();
  return sheet;
}

export async function closeContextWindowSheet(page: Page): Promise<void> {
  const sheet = contextWindowDetails(page);
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toHaveCount(0);
}

/** The hover card on wide screens and the sheet on compact ones are both this dialog. */
export function contextWindowDetails(page: Page): Locator {
  return page.getByRole("dialog", { name: "Context window" });
}

/** One report card; cards have no role of their own. */
export function usageCard(surface: Locator, reportId: string): Locator {
  return surface.getByTestId(`usage-report-${reportId}`);
}

export async function refreshUsageCard(surface: Locator, source: string): Promise<void> {
  await surface.getByRole("button", { name: `Refresh ${source}`, exact: true }).click();
}

export async function expectRefreshButtons(surface: Locator, count: number): Promise<void> {
  await expect(surface.getByRole("button", { name: /^Refresh / })).toHaveCount(count);
}

/** A report on the agent's own login, which is not the host's default one. */
export function onWorkLogin(report: UsageReportEntry): UsageReportEntry {
  return onLogin(report, "work");
}

/** A report on the login an agent resumed under. */
export function onPersonalLogin(report: UsageReportEntry): UsageReportEntry {
  return onLogin(report, "personal");
}

function onLogin(report: UsageReportEntry, login: string): UsageReportEntry {
  return {
    ...report,
    id: `${report.sourceId}:${login}`,
    account: { label: `${login}@example.com` },
  };
}

export function expiredLogin(report: UsageReportEntry): UsageReportEntry {
  return {
    ...report,
    report: {
      status: "unavailable",
      problem: {
        kind: "expired",
        expiresAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
        refreshedBy: "claude",
      },
    },
  };
}

/** Holds a stream at a point until the test opens it, like a slow source. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

export interface AgentUsageScript {
  /** The answer to the next agent usage request or report Refresh. */
  answerNext(response: UsageListResponse): void;
  /** From the next reload the host no longer reports usage. */
  stopReportingUsage(): void;
  /** The agent of each agent usage request, in order. */
  agentRequests(): string[];
  /** Each report Refresh, by report ID. */
  refreshedReports(): string[][];
}

/**
 * Scripts the host's usage: the host's own list is Claude and Codex on its default login; each
 * agent request and each Refresh takes the next scripted answer.
 */
export async function scriptAgentUsage(page: Page): Promise<AgentUsageScript> {
  let supported = true;
  const answers: UsageListResponse[] = [];
  const usage = await installUsageReportsFixture(page, {
    usageSupported: () => supported,
    lists: [
      (request) => {
        if (!request.agentId && !request.reportIds) return claudeAndCodexReports();
        const next = answers.shift();
        if (!next) throw new Error("The test scripts every agent usage request.");
        return next;
      },
    ],
  });
  return {
    answerNext: (response) => answers.push(response),
    stopReportingUsage: () => {
      supported = false;
    },
    agentRequests: () => usage.listRequests().flatMap((request) => request.agentId ?? []),
    refreshedReports: () =>
      usage.listRequests().flatMap((request) => (request.reportIds ? [request.reportIds] : [])),
  };
}

/** Set PASEO_QA_SCREENSHOT_DIR to keep a QA screenshot. */
export async function qaScreenshot(page: Page, name: string): Promise<void> {
  const directory = process.env.PASEO_QA_SCREENSHOT_DIR;
  if (!directory) return;
  // Let the sheet and hover card animations settle.
  await page.waitForTimeout(600);
  await page.addStyleTag({ content: ".__expo_fast_refresh { display: none !important; }" });
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
}
