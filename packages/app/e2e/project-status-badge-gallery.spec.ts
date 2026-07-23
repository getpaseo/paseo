/**
 * Verification capture for the unified collapsed-project status badge.
 *
 * Not a regression suite — it exists to produce the evidence gallery (per-state PNGs, an
 * animation burst for the loader, and a measured geometry dump) that proves every status
 * renders the *same* badge shell. Run it explicitly:
 *
 *   E2E_RECORD_VIDEO=1 npx playwright test e2e/project-status-badge-gallery.spec.ts
 *
 * Artifacts land in packages/app/.verification/project-status-badge/.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { daemonWsRoutePattern } from "./helpers/daemon-port";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import { expectMobileAgentSidebarVisible, openMobileAgentSidebar } from "./helpers/sidebar";
import { waitForSidebarHydration } from "./helpers/workspace-ui";

const OUT_DIR = path.resolve(__dirname, "../.verification/project-status-badge");

// Same key the app's settings hook writes to (@/hooks/use-settings/storage.ts). Kept as a
// local literal — same convention diff-row-alignment.spec.ts uses — so this spec doesn't
// reach into app source for a single string. Distinct from the legacy "@paseo:settings" key
// the paseoE2ESetup auto fixture clears, so seeding this doesn't race that reset.
const APP_SETTINGS_KEY = "@paseo:app-settings";

/**
 * `routeWebSocket` handler that swallows client -> daemon `project.remove.request`
 * messages instead of forwarding them, so `isRemovingProject` never resolves and the
 * archiving spinner stays mounted for the capture. Everything else passes through
 * untouched in both directions. Top-level (not inline) to stay under oxlint's
 * max-nested-callbacks limit.
 */
function dropProjectRemoveRequests(ws: import("@playwright/test").WebSocketRoute): void {
  const server = ws.connectToServer();
  ws.onMessage((message) => forwardUnlessProjectRemove(message, server));
  server.onMessage((message) => ws.send(message));
}

function forwardUnlessProjectRemove(
  message: string | Buffer,
  server: import("@playwright/test").WebSocketRoute,
): void {
  if (typeof message === "string" && message.includes('"type":"project.remove.request"')) {
    return; // dropped — never forwarded to the daemon
  }
  server.send(message);
}

// 3x so the captures are directly comparable with the pre-change gallery, which was shot at
// the same density — the geometry numbers in the plan are all in these device pixels.
test.use({ deviceScaleFactor: 3, viewport: { width: 1280, height: 900 } });

interface SeededState {
  label: string;
  bucket: string;
  workspace: SeededWorkspace;
}

/** Seeds one project and, unless the state is "done", one mock agent driving it into `bucket`. */
async function seedState(input: {
  label: string;
  bucket: string;
  model?: string;
  prompt?: string;
}): Promise<SeededState> {
  const workspace = await seedWorkspace({ repoPrefix: `badge-${input.label}` });
  if (input.prompt !== undefined) {
    await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: `badge-${input.label}`,
      modeId: "load-test",
      model: input.model ?? "ten-second-stream",
      initialPrompt: input.prompt,
    });
  }
  return { label: input.label, bucket: input.bucket, workspace };
}

/** Drives one same-directory workspace into `bucket` via the mock provider, or leaves it idle for "done". */
async function seedSubState(input: {
  client: SeededWorkspace["client"];
  cwd: string;
  workspaceId: string;
  label: string;
  bucket: "running" | "needs_input" | "attention" | "failed" | "done";
}): Promise<void> {
  if (input.bucket === "done") {
    return;
  }
  const model = input.bucket === "attention" ? "ten-second-stream" : "thirty-minute-stream";
  const PROMPT_BY_BUCKET: Record<"needs_input" | "attention" | "running" | "failed", string> = {
    needs_input: "emit a synthetic plan approval",
    attention: "finish quickly for the capture",
    running: "keep streaming for the capture",
    // Resolves the turn with a `turn_failed` event immediately — the duration profile never
    // matters, so this shares the same model pool as the other sub-states.
    failed: "emit a synthetic turn failure",
  };
  const prompt = PROMPT_BY_BUCKET[input.bucket];
  await input.client.createAgent({
    provider: "mock",
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    title: `${input.label}-${input.bucket}`,
    modeId: "load-test",
    model,
    initialPrompt: prompt,
  });
}

/**
 * Seeds one project with two same-directory workspaces (the "Model B" pattern from
 * same-directory-workspaces.spec.ts), each driven into its own bucket by the mock provider.
 * `base` is the first workspace/project handle; its `workspaceId` is workspace A.
 */
async function seedEdgeCaseProject(input: {
  label: string;
  bucketA: "running" | "needs_input" | "attention" | "failed" | "done";
  bucketB: "running" | "needs_input" | "attention" | "failed" | "done";
}): Promise<{ label: string; base: SeededWorkspace; secondWorkspaceId: string }> {
  const base = await seedWorkspace({ repoPrefix: `edge-${input.label}` });
  await seedSubState({
    client: base.client,
    cwd: base.repoPath,
    workspaceId: base.workspaceId,
    label: input.label,
    bucket: input.bucketA,
  });

  const second = await base.client.createWorkspace({
    source: { kind: "directory", path: base.repoPath, projectId: base.projectId },
    title: `${input.label}-b`,
  });
  if (!second.workspace) {
    throw new Error(second.error ?? `Failed to create second workspace for ${input.label}`);
  }
  await seedSubState({
    client: base.client,
    cwd: base.repoPath,
    workspaceId: second.workspace.id,
    label: input.label,
    bucket: input.bucketB,
  });

  return { label: input.label, base, secondWorkspaceId: second.workspace.id };
}

test.describe("collapsed project status badge", () => {
  test("captures every status in the shared badge shell", async ({ page }) => {
    test.setTimeout(240_000);
    await mkdir(OUT_DIR, { recursive: true });

    const states: SeededState[] = [];
    try {
      // running  — a stream long enough that the agent never leaves the running bucket.
      states.push(
        await seedState({
          label: "running",
          bucket: "running",
          model: "thirty-minute-stream",
          prompt: "keep streaming for the capture",
        }),
      );
      // needs_input — the mock provider parks on a synthetic plan-approval permission.
      states.push(
        await seedState({
          label: "needs-input",
          bucket: "needs_input",
          model: "thirty-minute-stream",
          prompt: "emit a synthetic plan approval",
        }),
      );
      // attention — a short stream that finishes and is never opened, so it stays unread.
      states.push(
        await seedState({
          label: "attention",
          bucket: "attention",
          model: "ten-second-stream",
          prompt: "finish quickly for the capture",
        }),
      );
      // failed — the mock provider's synthetic turn-failure trigger, which resolves the turn
      // with a `turn_failed` event immediately (no duration profile involved).
      states.push(
        await seedState({
          label: "failed",
          bucket: "failed",
          prompt: "emit a synthetic turn failure",
        }),
      );
      // done — a project with no agents at all.
      states.push(await seedState({ label: "done", bucket: "done" }));

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      // Collapse every seeded project: the status badge only surfaces on a row that is
      // hiding its workspaces.
      for (const state of states) {
        const row = page.getByTestId(`sidebar-project-row-${state.workspace.projectId}`);
        await expect(row).toBeVisible({ timeout: 60_000 });
        await row.click();
      }

      // Park the pointer off the sidebar. A hovered project row swaps its icon for the
      // expand chevron, which would otherwise hide the badge on whichever row was clicked
      // last — the "done" row would look like a chevron rather than a plain icon.
      await page.mouse.move(1200, 850);

      // Wait for each row to actually carry the badge it should before capturing, so a
      // screenshot can never silently record a not-yet-settled state.
      for (const state of states) {
        const row = page.getByTestId(`sidebar-project-row-${state.workspace.projectId}`);
        if (state.bucket === "done") {
          await expect(row.getByTestId("project-status-badge")).toHaveCount(0, { timeout: 60_000 });
          continue;
        }
        await expect(row.getByTestId(`project-status-indicator-${state.bucket}`)).toBeVisible({
          timeout: 60_000,
        });
        await expect(row.getByTestId("project-status-badge")).toBeVisible({ timeout: 60_000 });
      }

      // --- per-state stills -------------------------------------------------------------
      for (const state of states) {
        const row = page.getByTestId(`sidebar-project-row-${state.workspace.projectId}`);
        await row.screenshot({ path: path.join(OUT_DIR, `state-${state.label}.png`) });
      }

      // --- geometry dump ----------------------------------------------------------------
      // The actual proof: every badge's rendered box, straight from the DOM. If the shells
      // agree, the "same size circle" requirement holds by measurement, not by eye.
      const geometry = await page.evaluate(() => {
        const box = (el: Element | null) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            w: +r.width.toFixed(2),
            h: +r.height.toFixed(2),
            x: +r.x.toFixed(2),
            y: +r.y.toFixed(2),
          };
        };
        const offsetOf = (badge: Element | null, indicator: Element | null) => {
          if (!badge || !indicator) return null;
          const b = badge.getBoundingClientRect();
          const i = indicator.getBoundingClientRect();
          return {
            right: +(i.right - b.right).toFixed(2),
            bottom: +(i.bottom - b.bottom).toFixed(2),
          };
        };

        // The running badge holds a radially-symmetric ring spinner. Its rotation center is
        // its geometric center at every instant, so proving "centered" reduces to: is every
        // sized descendant's box centered on the badge center? Walk them all and report the
        // worst offset — a single flat loop keeps this lint-clean and snake-independent.
        const loaderProbe = (badge: Element | null) => {
          if (!badge) return null;
          const bc = badge.getBoundingClientRect();
          const badgeCenterX = bc.x + bc.width / 2;
          const badgeCenterY = bc.y + bc.height / 2;
          const rects = [];
          let maxAbsDx = 0;
          let maxAbsDy = 0;
          for (const el of badge.querySelectorAll("*")) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            const dx = +(r.x + r.width / 2 - badgeCenterX).toFixed(3);
            const dy = +(r.y + r.height / 2 - badgeCenterY).toFixed(3);
            rects.push({ w: +r.width.toFixed(2), h: +r.height.toFixed(2), dx, dy });
            maxAbsDx = Math.max(maxAbsDx, Math.abs(dx));
            maxAbsDy = Math.max(maxAbsDy, Math.abs(dy));
          }
          return {
            badgeCenterX: +badgeCenterX.toFixed(3),
            sizedDescendants: rects.length,
            // Worst center offset of any sized element vs the badge center. ~0 == concentric.
            maxAbsDx: +maxAbsDx.toFixed(3),
            maxAbsDy: +maxAbsDy.toFixed(3),
            rects,
          };
        };

        const measured = [];
        for (const row of document.querySelectorAll('[data-testid^="sidebar-project-row-"]')) {
          const badge = row.querySelector('[data-testid="project-status-badge"]');
          const dot = row.querySelector('[data-testid="project-status-dot"]');
          const indicator = row.querySelector('[data-testid^="project-status-indicator-"]');
          measured.push({
            testId: row.getAttribute("data-testid"),
            indicator: indicator?.getAttribute("data-testid") ?? null,
            badge: box(badge),
            iconSlot: box(indicator),
            dot: box(dot),
            // Badge position relative to the indicator slot's bottom-right corner.
            offset: offsetOf(badge, indicator),
            loader: loaderProbe(badge),
          });
        }
        return measured;
      });
      await writeFile(
        path.join(OUT_DIR, "geometry.json"),
        `${JSON.stringify(geometry, null, 2)}\n`,
        "utf8",
      );

      // --- loader animation burst --------------------------------------------------------
      // The spinner is the state the user called out as visually off-center. One still can't
      // show centering across the snake's phases, so shoot a burst covering a full ~950ms
      // cycle; these get assembled into a GIF outside the spec.
      const runningState = states.find((entry) => entry.label === "running");
      if (runningState) {
        const runningRow = page.getByTestId(
          `sidebar-project-row-${runningState.workspace.projectId}`,
        );
        await mkdir(path.join(OUT_DIR, "loader-frames"), { recursive: true });
        for (let frame = 0; frame < 30; frame += 1) {
          await runningRow.screenshot({
            path: path.join(
              OUT_DIR,
              "loader-frames",
              `frame-${String(frame).padStart(2, "0")}.png`,
            ),
          });
          await page.waitForTimeout(40);
        }
      }

      // --- the money shot: every seeded row together --------------------------------------
      // A viewport screenshot, not an element screenshot: the project list is a
      // DraggableList (dnd-kit) wrapper whose internal measurement never settles, so
      // Playwright's element-screenshot stability check hangs on it indefinitely. Per-row
      // element screenshots above are unaffected — only THIS container is the problem.
      await page.screenshot({ path: path.join(OUT_DIR, "all-states.png") });
    } finally {
      for (const state of states) {
        await state.workspace.cleanup().catch(() => undefined);
      }
    }
  });

  test("captures the aggregation edge cases and the expanded control", async ({ page }) => {
    test.setTimeout(240_000);
    const EDGE_OUT_DIR = path.join(OUT_DIR, "edge-cases");
    await mkdir(EDGE_OUT_DIR, { recursive: true });

    const projects: SeededWorkspace[] = [];
    try {
      // Each edge case is one project with TWO same-directory workspaces (the model the
      // "Same-directory workspaces" spec pins), one per sub-bucket, so the collapsed row has
      // to pick a winner via aggregateSidebarStateBuckets' priority order.
      const runningAttention = await seedEdgeCaseProject({
        label: "running-plus-attention",
        bucketA: "running",
        bucketB: "attention",
      });
      const needsInputRunning = await seedEdgeCaseProject({
        label: "needs-input-plus-running",
        bucketA: "needs_input",
        bucketB: "running",
      });
      const attentionDone = await seedEdgeCaseProject({
        label: "attention-plus-done",
        bucketA: "attention",
        bucketB: "done",
      });
      const allDone = await seedEdgeCaseProject({
        label: "all-done",
        bucketA: "done",
        bucketB: "done",
      });
      // failed beats running: proves the priority order (needs_input > failed > running >
      // attention > done) holds for the previously-uncovered "failed" bucket.
      const failedRunning = await seedEdgeCaseProject({
        label: "failed-plus-running",
        bucketA: "failed",
        bucketB: "running",
      });
      // needs_input still wins over failed — the one bucket that outranks it.
      const needsInputFailed = await seedEdgeCaseProject({
        label: "needs-input-plus-failed",
        bucketA: "needs_input",
        bucketB: "failed",
      });
      // Control: a single-workspace project left EXPANDED. The project row must carry NO
      // badge — status rides the workspace row instead, the inverse of every collapsed case
      // above. This is what proves the badge is collapse-only, not "always on".
      const control = await seedEdgeCaseProject({
        label: "expanded-control",
        bucketA: "running",
        bucketB: "done",
      });

      projects.push(
        runningAttention.base,
        needsInputRunning.base,
        attentionDone.base,
        allDone.base,
        failedRunning.base,
        needsInputFailed.base,
        control.base,
      );

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      const collapsing = [
        runningAttention,
        needsInputRunning,
        attentionDone,
        allDone,
        failedRunning,
        needsInputFailed,
      ];
      for (const edge of collapsing) {
        const row = page.getByTestId(`sidebar-project-row-${edge.base.projectId}`);
        await expect(row).toBeVisible({ timeout: 60_000 });
        await row.click();
      }
      // control.base stays expanded — never clicked.

      await page.mouse.move(1200, 850);

      // Split by expected outcome rather than branching per-item on a nullable field: each
      // array's seeded state is deterministic, so every assertion path is fixed at seed time
      // instead of decided by the test body at runtime.
      const badgeExpectations: Array<{ label: string; projectId: string; expectedBadge: string }> =
        [
          {
            label: runningAttention.label,
            projectId: runningAttention.base.projectId,
            expectedBadge: "running",
          },
          {
            label: needsInputRunning.label,
            projectId: needsInputRunning.base.projectId,
            expectedBadge: "needs_input",
          },
          {
            label: attentionDone.label,
            projectId: attentionDone.base.projectId,
            expectedBadge: "attention",
          },
          {
            label: failedRunning.label,
            projectId: failedRunning.base.projectId,
            expectedBadge: "failed",
          },
          {
            label: needsInputFailed.label,
            projectId: needsInputFailed.base.projectId,
            expectedBadge: "needs_input",
          },
        ];
      const noBadgeExpectations: Array<{ label: string; projectId: string }> = [
        { label: allDone.label, projectId: allDone.base.projectId },
      ];
      const expectations = [...badgeExpectations, ...noBadgeExpectations];

      for (const expectation of badgeExpectations) {
        const row = page.getByTestId(`sidebar-project-row-${expectation.projectId}`);
        await expect(
          row.getByTestId(`project-status-indicator-${expectation.expectedBadge}`),
        ).toBeVisible({ timeout: 60_000 });
        await expect(row.getByTestId("project-status-badge")).toBeVisible({ timeout: 60_000 });
      }
      for (const expectation of noBadgeExpectations) {
        const row = page.getByTestId(`sidebar-project-row-${expectation.projectId}`);
        await expect(row.getByTestId("project-status-badge")).toHaveCount(0, { timeout: 60_000 });
      }

      // Control assertions: no badge on the expanded project row, but the running workspace
      // row underneath it does carry the status.
      const controlRow = page.getByTestId(`sidebar-project-row-${control.base.projectId}`);
      await expect(controlRow.getByTestId("project-status-badge")).toHaveCount(0, {
        timeout: 60_000,
      });
      const controlRunningWorkspaceRow = page.getByTestId(
        `sidebar-workspace-row-${getServerId()}:${control.base.workspaceId}`,
      );
      await expect(
        controlRunningWorkspaceRow.getByTestId("workspace-status-indicator-running"),
      ).toBeVisible({ timeout: 60_000 });

      for (const expectation of expectations) {
        const row = page.getByTestId(`sidebar-project-row-${expectation.projectId}`);
        await row.screenshot({ path: path.join(EDGE_OUT_DIR, `edge-${expectation.label}.png`) });
      }

      // The control's own project-row screenshot (no badge) doesn't show the point of this
      // case — that status moved to the workspace row below it. Clip a region spanning the
      // project row down through the running workspace row, using only the two row locators
      // already proven to resolve above (not the DraggableList wrapper — see the money-shot
      // comment in the other test for why that one hangs).
      const controlProjectBox = await controlRow.boundingBox();
      const controlRunningRowBox = await controlRunningWorkspaceRow.boundingBox();
      if (controlProjectBox && controlRunningRowBox) {
        await page.screenshot({
          path: path.join(EDGE_OUT_DIR, `edge-${control.label}.png`),
          clip: {
            x: Math.min(controlProjectBox.x, controlRunningRowBox.x) - 8,
            y: controlProjectBox.y - 4,
            width: Math.max(controlProjectBox.width, controlRunningRowBox.width) + 16,
            // Down through the running row plus headroom for the second ("done") workspace
            // row beneath it, so both same-directory workspaces are visible.
            height: controlRunningRowBox.y + controlRunningRowBox.height - controlProjectBox.y + 60,
          },
        });
      }

      await page.screenshot({ path: path.join(EDGE_OUT_DIR, "all-edge-cases.png") });
    } finally {
      for (const project of projects) {
        await project.cleanup().catch(() => undefined);
      }
    }
  });

  test("captures every visible status in dark mode", async ({ page }) => {
    test.setTimeout(240_000);
    const DARK_OUT_DIR = path.join(OUT_DIR, "dark-mode");
    await mkdir(DARK_OUT_DIR, { recursive: true });

    // Force dark regardless of the OS/browser color-scheme preference. Must run before
    // gotoAppShell's navigation so the app boots with it already in storage.
    await page.addInitScript(
      ({ settingsKey }) => {
        localStorage.setItem(settingsKey, JSON.stringify({ theme: "dark" }));
      },
      { settingsKey: APP_SETTINGS_KEY },
    );

    const states: SeededState[] = [];
    try {
      states.push(
        await seedState({
          label: "dark-running",
          bucket: "running",
          model: "thirty-minute-stream",
          prompt: "keep streaming for the capture",
        }),
      );
      states.push(
        await seedState({
          label: "dark-needs-input",
          bucket: "needs_input",
          model: "thirty-minute-stream",
          prompt: "emit a synthetic plan approval",
        }),
      );
      states.push(
        await seedState({
          label: "dark-failed",
          bucket: "failed",
          prompt: "emit a synthetic turn failure",
        }),
      );
      states.push(
        await seedState({
          label: "dark-attention",
          bucket: "attention",
          model: "ten-second-stream",
          prompt: "finish quickly for the capture",
        }),
      );
      states.push(await seedState({ label: "dark-done", bucket: "done" }));

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      for (const state of states) {
        const row = page.getByTestId(`sidebar-project-row-${state.workspace.projectId}`);
        await expect(row).toBeVisible({ timeout: 60_000 });
        await row.click();
      }
      await page.mouse.move(1200, 850);

      for (const state of states) {
        const row = page.getByTestId(`sidebar-project-row-${state.workspace.projectId}`);
        if (state.bucket === "done") {
          await expect(row.getByTestId("project-status-badge")).toHaveCount(0, { timeout: 60_000 });
          continue;
        }
        await expect(row.getByTestId(`project-status-indicator-${state.bucket}`)).toBeVisible({
          timeout: 60_000,
        });
        await expect(row.getByTestId("project-status-badge")).toBeVisible({ timeout: 60_000 });
      }

      // Sanity check the theme actually flipped: unistyles' colorScheme drives
      // theme.colors.surfaceSidebar / surface0, so the sidebar background itself must be
      // dark, not just the badge. Read one pixel from a definitely-sidebar region.
      const sidebarBg = await page.evaluate(() => {
        const el = document.elementFromPoint(20, 20);
        if (!el) return null;
        return getComputedStyle(el).backgroundColor;
      });

      // Geometry + background-color dump for the pixel verification pass done outside the
      // spec (ImageMagick against the PNGs) — mirrors the light-mode geometry.json pattern
      // but scoped to what dark mode needs to prove: badge boxes to crop precisely, plus the
      // raw background read above.
      const geometry = await page.evaluate(() => {
        const box = (el: Element | null) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            w: +r.width.toFixed(2),
            h: +r.height.toFixed(2),
            x: +r.x.toFixed(2),
            y: +r.y.toFixed(2),
          };
        };
        const measured = [];
        for (const row of document.querySelectorAll('[data-testid^="sidebar-project-row-"]')) {
          const badge = row.querySelector('[data-testid="project-status-badge"]');
          const indicator = row.querySelector('[data-testid^="project-status-indicator-"]');
          measured.push({
            testId: row.getAttribute("data-testid"),
            indicator: indicator?.getAttribute("data-testid") ?? null,
            badge: box(badge),
          });
        }
        return measured;
      });
      await writeFile(
        path.join(DARK_OUT_DIR, "geometry.json"),
        `${JSON.stringify({ sidebarBackgroundColor: sidebarBg, rows: geometry }, null, 2)}\n`,
        "utf8",
      );

      for (const state of states) {
        const row = page.getByTestId(`sidebar-project-row-${state.workspace.projectId}`);
        await row.screenshot({ path: path.join(DARK_OUT_DIR, `state-${state.label}.png`) });
      }
      await page.screenshot({ path: path.join(DARK_OUT_DIR, "all-states-dark.png") });
    } finally {
      for (const state of states) {
        await state.workspace.cleanup().catch(() => undefined);
      }
    }
  });

  // SKIPPED (archiving capture): could not get `project-status-indicator-archiving` to render
  // in this harness despite several targeted fixes, so this is left disabled rather than flaky
  // or faked. What's confirmed:
  //  - The remove flow does run: the confirm() dialog fires and is accepted, and the dropdown
  //    closes normally.
  //  - ProjectLeadingVisual's showChevron (hover) branch is checked BEFORE isArchiving, so a
  //    row left "hovered" by the kebab/menu interaction renders the expand chevron over the
  //    spinner regardless of isArchiving's value. Explicit unhover (mouse-move-away, a settle
  //    wait plus a second move-away, and finally a direct pointerleave dispatch on the row) was
  //    tried and did not make the indicator appear within a 15s window either.
  // That leaves two live hypotheses this harness doesn't distinguish: (a) some other hover/focus
  // path keeps re-asserting itself after the menu closes, or (b) `isRemovingProject` never
  // actually renders true for a full frame in this test daemon (e.g. a readiness/feature-gate
  // check short-circuits synchronously so React never paints the intermediate true state). A
  // real bug is possible here — flagged for a maintainer to reproduce with the DOM inspector
  // live rather than guessed at further via screenshots.
  test.skip("captures the archiving spinner via a dropped project.remove.request", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const ARCHIVING_OUT_DIR = path.join(OUT_DIR, "archiving");
    await mkdir(ARCHIVING_OUT_DIR, { recursive: true });

    // Swallow the client -> daemon project.remove.request so isRemovingProject never
    // resolves. This must be registered before gotoAppShell navigates, since routeWebSocket
    // only intercepts sockets opened after it's armed. The project is never actually
    // removed mid-test — the seed client's cleanup() below uses its own, unrouted
    // connection to remove it for real afterward.
    await page.routeWebSocket(daemonWsRoutePattern(), dropProjectRemoveRequests);

    const workspace = await seedWorkspace({ repoPrefix: "badge-archiving-" });
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      const row = page.getByTestId(`sidebar-project-row-${workspace.projectId}`);
      await expect(row).toBeVisible({ timeout: 60_000 });
      await row.hover();

      const kebab = page.getByTestId(`sidebar-project-kebab-${workspace.projectId}`);
      await expect(kebab).toBeVisible({ timeout: 10_000 });
      await kebab.click();

      page.once("dialog", (dialog) => void dialog.accept());
      const removeItem = page.getByTestId(`sidebar-project-menu-remove-${workspace.projectId}`);
      await expect(removeItem).toBeVisible({ timeout: 10_000 });
      await removeItem.click();

      // ProjectLeadingVisual checks showChevron (hover) before isArchiving, so the row must
      // stop being "hovered" for the spinner to win instead of the chevron — see the skip note
      // above for what was tried here and why it wasn't enough to unblock this capture.
      await expect(removeItem).not.toBeVisible({ timeout: 10_000 });
      await row.dispatchEvent("pointerleave");
      await page.mouse.move(1200, 850);

      const archivingIndicator = row.getByTestId("project-status-indicator-archiving");
      await expect(archivingIndicator).toBeVisible({ timeout: 15_000 });
      await row.screenshot({ path: path.join(ARCHIVING_OUT_DIR, "state-archiving.png") });
    } finally {
      await workspace.cleanup().catch(() => undefined);
    }
  });

  test("captures the badge swapped for the hover chevron and back", async ({ page }) => {
    test.setTimeout(120_000);
    const HOVER_OUT_DIR = path.join(OUT_DIR, "hover");
    await mkdir(HOVER_OUT_DIR, { recursive: true });

    const state = await seedState({
      label: "hover-running",
      bucket: "running",
      model: "thirty-minute-stream",
      prompt: "keep streaming for the capture",
    });
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      const row = page.getByTestId(`sidebar-project-row-${state.workspace.projectId}`);
      await expect(row).toBeVisible({ timeout: 60_000 });
      await row.click(); // collapse so the badge has something to show

      // Baseline: pointer off the row, badge visible on the icon.
      await page.mouse.move(1200, 850);
      await expect(row.getByTestId("project-status-indicator-running")).toBeVisible({
        timeout: 60_000,
      });
      await expect(row.getByTestId("project-status-badge")).toBeVisible({ timeout: 60_000 });
      await row.screenshot({ path: path.join(HOVER_OUT_DIR, "unhovered.png") });

      // Hovered: the leading slot swaps the icon (and its badge) for the expand chevron.
      // ProjectInlineChevron carries no testID of its own, so the icon/badge disappearing
      // is the assertable half of this — the chevron glyph itself is confirmed by reading
      // the screenshot back below.
      await row.hover();
      await expect(row.getByTestId("project-status-indicator-running")).toHaveCount(0, {
        timeout: 10_000,
      });
      await expect(row.getByTestId("project-status-badge")).toHaveCount(0, { timeout: 10_000 });
      await row.screenshot({ path: path.join(HOVER_OUT_DIR, "hovered.png") });
    } finally {
      await state.workspace.cleanup().catch(() => undefined);
    }
  });

  test("records the running badge animating through an expand-to-workspace-row transition", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const state = await seedState({
      label: "recording-running",
      bucket: "running",
      model: "thirty-minute-stream",
      prompt: "keep streaming for the capture",
    });
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      const row = page.getByTestId(`sidebar-project-row-${state.workspace.projectId}`);
      await expect(row).toBeVisible({ timeout: 60_000 });
      await row.click(); // collapse

      await page.mouse.move(1200, 850);
      await expect(row.getByTestId("project-status-indicator-running")).toBeVisible({
        timeout: 60_000,
      });
      await expect(row.getByTestId("project-status-badge")).toBeVisible({ timeout: 60_000 });

      // Let the loader animate on tape for a beat before the transition.
      await page.waitForTimeout(1500);

      // Expand: the badge disappears from the project row and the running status moves to
      // the workspace row underneath it instead.
      await row.click();
      const workspaceRow = page.getByTestId(
        `sidebar-workspace-row-${getServerId()}:${state.workspace.workspaceId}`,
      );
      await expect(workspaceRow.getByTestId("workspace-status-indicator-running")).toBeVisible({
        timeout: 60_000,
      });
      await expect(row.getByTestId("project-status-badge")).toHaveCount(0, { timeout: 60_000 });

      await page.waitForTimeout(800);
    } finally {
      await state.workspace.cleanup().catch(() => undefined);
    }
  });
});

test.describe("collapsed project status badge — compact viewport", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("captures the status badge at a narrow (compact) form factor", async ({ page }) => {
    test.setTimeout(120_000);
    const COMPACT_OUT_DIR = path.join(OUT_DIR, "compact");
    await mkdir(COMPACT_OUT_DIR, { recursive: true });

    const state = await seedState({
      label: "compact-needs-input",
      bucket: "needs_input",
      model: "thirty-minute-stream",
      prompt: "emit a synthetic plan approval",
    });
    try {
      await gotoAppShell(page);
      await openMobileAgentSidebar(page);
      await expectMobileAgentSidebarVisible(page);

      const row = page.getByTestId(`sidebar-project-row-${state.workspace.projectId}`);
      await expect(row).toBeVisible({ timeout: 60_000 });
      await row.click(); // collapse

      // Park the pointer off the row — same reason as the desktop captures: a hovered
      // project row swaps its icon (and badge) for the expand chevron. 350,820 stays inside
      // the 390x844 compact viewport, below the seeded project row.
      await page.mouse.move(350, 820);

      await expect(row.getByTestId("project-status-indicator-needs_input")).toBeVisible({
        timeout: 60_000,
      });
      await expect(row.getByTestId("project-status-badge")).toBeVisible({ timeout: 60_000 });
      await row.screenshot({ path: path.join(COMPACT_OUT_DIR, "state-needs-input-compact.png") });
      await page.screenshot({ path: path.join(COMPACT_OUT_DIR, "sidebar-compact.png") });
    } finally {
      await state.workspace.cleanup().catch(() => undefined);
    }
  });
});
