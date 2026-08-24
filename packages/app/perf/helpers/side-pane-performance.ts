import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";

const APP_SETTINGS_KEY = "@paseo:app-settings";

export interface ProfileTarget {
  serverId: string;
  workspaceId: string;
}

export interface RenderSummary {
  id: string;
  renders: number;
  mounts: number;
  updates: number;
  actualDurationMs: number;
  maximumActualDurationMs: number;
}

export interface InteractionMeasurement {
  name: string;
  latencyMs: number;
  commits: number;
  domMutations: number;
  addedElements: number;
  removedElements: number;
  addedTestIds: string[];
  removedTestIds: string[];
  trackedNodes: Array<{
    selector: string;
    existedBefore: boolean;
    connected: boolean;
    sameNode: boolean;
  }>;
  renders: RenderSummary[];
  reasons: Record<string, Record<string, number>>;
  heapAfterGcBytes?: number;
}

interface BrowserMeasurementState {
  startedAt: number;
  selectors: string[];
  originals: Array<Element | null>;
  observer?: MutationObserver;
  domMutations: number;
  addedElements: number;
  removedElements: number;
  addedTestIds: Set<string>;
  removedTestIds: Set<string>;
}

declare global {
  interface Window {
    __PASEO_SIDE_PANE_MEASUREMENT__?: BrowserMeasurementState;
  }
}

function parseCliJson<T>(output: string): T {
  const arrayStart = output.indexOf("[\n");
  const objectStart = output.indexOf("{\n");
  const start = arrayStart >= 0 ? arrayStart : objectStart;
  if (start < 0) throw new Error(`Could not find JSON in CLI output: ${output}`);
  return JSON.parse(output.slice(start)) as T;
}

export function resolveProfileTarget(): ProfileTarget {
  const repoRoot = resolve(process.cwd(), "../..");
  const serverId = (
    process.env.PASEO_PROFILE_SERVER_ID ??
    readFileSync(resolve(repoRoot, ".dev/paseo-home/server-id"), "utf8")
  ).trim();
  const requestedName = process.env.PASEO_PROFILE_WORKSPACE_NAME?.trim() || "Paseo";
  const requestedWorkspaceId = process.env.PASEO_PROFILE_WORKSPACE_ID?.trim();
  if (requestedWorkspaceId) return { serverId, workspaceId: requestedWorkspaceId };

  const output = execFileSync("npm", ["run", "cli", "--", "workspace", "ls", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const workspaces =
    parseCliJson<Array<{ workspaceId: string; name: string; cwd: string }>>(output);
  const workspace = workspaces.find(
    (candidate) => candidate.name === requestedName && candidate.cwd === repoRoot,
  );
  if (!workspace) {
    throw new Error(`No Paseo workspace named ${requestedName} points at ${repoRoot}`);
  }
  return { serverId, workspaceId: workspace.workspaceId };
}

export async function openProfileWorkspace(page: Page, target: ProfileTarget): Promise<void> {
  await page.addInitScript(() => {
    const preserveRenderProfile = (original: History["pushState"]) =>
      function preserveProfileParam(
        this: History,
        state: unknown,
        unused: string,
        url?: string | URL | null,
      ) {
        if (url == null) return Reflect.apply(original, this, [state, unused, url]);
        const nextUrl = new URL(String(url), location.href);
        nextUrl.searchParams.set("renderProfile", "1");
        return Reflect.apply(original, this, [
          state,
          unused,
          `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
        ]);
      };
    history.pushState = preserveRenderProfile(history.pushState);
    history.replaceState = preserveRenderProfile(history.replaceState);
  });
  await page.goto("/?renderProfile=1", { waitUntil: "domcontentloaded" });
  const workspaceRow = page.getByTestId(
    `sidebar-workspace-row-${target.serverId}:${target.workspaceId}`,
  );
  await expect(workspaceRow).toBeVisible({ timeout: 60_000 });
  await workspaceRow.click();
  await expect(
    page.getByTestId("workspace-tabs-row").filter({ visible: true }).first(),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("workspace-explorer-toggle").first()).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/workspace/${target.workspaceId}\\?renderProfile=1$`));
}

export async function enableChangesOpenInSidePane(page: Page): Promise<void> {
  await page.evaluate((settingsKey) => {
    const persisted = JSON.parse(localStorage.getItem(settingsKey) ?? "{}") as Record<
      string,
      unknown
    >;
    const currentPreferences =
      typeof persisted.openInSidePane === "object" && persisted.openInSidePane !== null
        ? (persisted.openInSidePane as Record<string, unknown>)
        : {};
    localStorage.setItem(
      settingsKey,
      JSON.stringify({
        ...persisted,
        openInSidePane: { ...currentPreferences, explorerChanges: true },
      }),
    );
  }, APP_SETTINGS_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByTestId("workspace-tabs-row").filter({ visible: true }).first(),
  ).toBeVisible({
    timeout: 60_000,
  });
}

export async function openChangesExplorer(page: Page): Promise<void> {
  const explorer = page.getByTestId("workspace-explorer-sidebar");
  if ((await explorer.count()) === 0) {
    await page.keyboard.press("Meta+e");
  }
  await expect(explorer).toBeVisible({ timeout: 30_000 });
  const changesTab = explorer.getByRole("button", { name: /Working tree diff/i }).first();
  await expect(changesTab).toBeVisible();
  if ((await changesTab.getAttribute("aria-selected")) !== "true") {
    await changesTab.click();
  }
  await expect(page.getByTestId("changes-tree-panel")).toBeVisible({ timeout: 30_000 });
  await expect(changedFileRows(page).nth(1)).toBeVisible({ timeout: 30_000 });
}

export function changedFileRows(page: Page): Locator {
  return page
    .locator('[data-testid^="diff-tree-file-"][data-testid$="-toggle"]')
    .filter({ visible: true });
}

export async function selectChangedFile(page: Page, index: number): Promise<void> {
  const row = changedFileRows(page).nth(index);
  await expect(row).toBeVisible();
  await row.click();
  await expect(row).toHaveAttribute("aria-selected", "true");
}

export async function expectWorkingDiffVisible(page: Page): Promise<void> {
  await expect(page.getByTestId("working-diff-panel").filter({ visible: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("git-diff-canvas").filter({ visible: true })).toBeVisible({
    timeout: 60_000,
  });
}

export async function closeWorkingDiffPane(page: Page): Promise<void> {
  const tab = page.getByTestId("workspace-tab-working_diff").filter({ visible: true }).first();
  await expect(tab).toBeVisible();
  await tab.hover();
  await page
    .locator('[data-testid^="workspace-working-diff-close-"]')
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.getByTestId("working-diff-panel").filter({ visible: true })).toHaveCount(0);
}

export async function measureHeapAfterGc(page: Page): Promise<number> {
  await page.requestGC();
  return page.evaluate(() => {
    const memory = performance as Performance & {
      memory?: { usedJSHeapSize: number };
    };
    return memory.memory?.usedJSHeapSize ?? 0;
  });
}

async function waitForReactIdle(page: Page, quietMs = 250): Promise<void> {
  let previousCount = -1;
  let unchangedSince = Date.now();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const count = await page.evaluate(() => globalThis.__PASEO_RENDER_PROFILE__?.length ?? 0);
    if (count !== previousCount) {
      previousCount = count;
      unchangedSince = Date.now();
    } else if (Date.now() - unchangedSince >= quietMs) {
      return;
    }
    await page.waitForTimeout(25);
  }
  throw new Error("React profiler did not become idle");
}

function summarizeRenders(
  samples: Array<{
    id: string;
    phase: "mount" | "update" | "nested-update";
    actualDuration: number;
  }>,
): RenderSummary[] {
  const summaries = new Map<string, RenderSummary>();
  for (const sample of samples) {
    const summary = summaries.get(sample.id) ?? {
      id: sample.id,
      renders: 0,
      mounts: 0,
      updates: 0,
      actualDurationMs: 0,
      maximumActualDurationMs: 0,
    };
    summary.renders += 1;
    summary.mounts += sample.phase === "mount" ? 1 : 0;
    summary.updates += sample.phase === "mount" ? 0 : 1;
    summary.actualDurationMs += sample.actualDuration;
    summary.maximumActualDurationMs = Math.max(
      summary.maximumActualDurationMs,
      sample.actualDuration,
    );
    summaries.set(sample.id, summary);
  }
  for (const summary of summaries.values()) {
    summary.actualDurationMs = Math.round(summary.actualDurationMs * 100) / 100;
    summary.maximumActualDurationMs = Math.round(summary.maximumActualDurationMs * 100) / 100;
  }
  return [...summaries.values()].sort(
    (left, right) => right.actualDurationMs - left.actualDurationMs,
  );
}

async function beginMeasurement(page: Page, selectors: string[]): Promise<void> {
  await waitForReactIdle(page);
  await page.evaluate((trackedSelectors) => {
    globalThis.__PASEO_RESET_RENDER_PROFILE__?.();
    const collectTestIds = (node: Node, output: Set<string>) => {
      if (!(node instanceof Element)) return;
      const ownTestId = node.getAttribute("data-testid");
      if (ownTestId) output.add(ownTestId);
      for (const element of node.querySelectorAll("[data-testid]")) {
        const testId = element.getAttribute("data-testid");
        if (testId) output.add(testId);
      }
    };
    const state: BrowserMeasurementState = {
      startedAt: performance.now(),
      selectors: trackedSelectors,
      originals: trackedSelectors.map((selector) => document.querySelector(selector)),
      domMutations: 0,
      addedElements: 0,
      removedElements: 0,
      addedTestIds: new Set(),
      removedTestIds: new Set(),
    };
    state.observer = new MutationObserver((records) => {
      state.domMutations += records.length;
      for (const record of records) {
        for (const node of record.addedNodes) {
          state.addedElements +=
            node instanceof Element ? 1 + node.querySelectorAll("*").length : 0;
          collectTestIds(node, state.addedTestIds);
        }
        for (const node of record.removedNodes) {
          state.removedElements +=
            node instanceof Element ? 1 + node.querySelectorAll("*").length : 0;
          collectTestIds(node, state.removedTestIds);
        }
      }
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
    window.__PASEO_SIDE_PANE_MEASUREMENT__ = state;
  }, selectors);
}

async function finishMeasurement(page: Page, name: string): Promise<InteractionMeasurement> {
  await page.evaluate(
    () =>
      new Promise<void>((resolveFrame) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()));
      }),
  );
  await waitForReactIdle(page);
  const raw = await page.evaluate((measurementName) => {
    const state = window.__PASEO_SIDE_PANE_MEASUREMENT__;
    if (!state) throw new Error("Side-pane performance measurement was not started");
    state.observer?.disconnect();
    const samples = globalThis.__PASEO_RENDER_PROFILE__ ?? [];
    return {
      name: measurementName,
      latencyMs: Math.round((performance.now() - state.startedAt) * 100) / 100,
      commits: new Set(samples.map((sample) => sample.commitTime)).size,
      domMutations: state.domMutations,
      addedElements: state.addedElements,
      removedElements: state.removedElements,
      addedTestIds: [...state.addedTestIds].sort(),
      removedTestIds: [...state.removedTestIds].sort(),
      trackedNodes: state.selectors.map((selector, index) => {
        const original = state.originals[index] ?? null;
        const current = document.querySelector(selector);
        return {
          selector,
          existedBefore: original !== null,
          connected: original?.isConnected ?? false,
          sameNode: original !== null && original === current,
        };
      }),
      samples,
      reasons: globalThis.__PASEO_RENDER_PROFILE_REASONS__ ?? {},
    };
  }, name);
  return {
    ...raw,
    renders: summarizeRenders(raw.samples),
  };
}

export async function measureInteraction(
  page: Page,
  input: {
    name: string;
    trackedSelectors: string[];
    interact: () => Promise<void>;
    expectComplete: () => Promise<void>;
  },
): Promise<InteractionMeasurement> {
  await beginMeasurement(page, input.trackedSelectors);
  await input.interact();
  await input.expectComplete();
  return finishMeasurement(page, input.name);
}

export function expectTrackedNodePreserved(
  measurement: InteractionMeasurement,
  selector: string,
): void {
  const tracked = measurement.trackedNodes.find((candidate) => candidate.selector === selector);
  expect.soft(tracked).toEqual({
    selector,
    existedBefore: true,
    connected: true,
    sameNode: true,
  });
}

export function expectProfilerDidNotMount(
  measurement: InteractionMeasurement,
  idPrefix: string,
): void {
  const summaries = measurement.renders.filter((summary) => summary.id.startsWith(idPrefix));
  expect.soft(summaries.length).toBeGreaterThan(0);
  expect.soft(summaries.every((summary) => summary.mounts === 0)).toBe(true);
}
