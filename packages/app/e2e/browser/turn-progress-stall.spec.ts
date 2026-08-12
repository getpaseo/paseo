import { test, expect } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { expectInlineWorkingIndicator } from "../support/helpers/agent-stream";
import { waitForPermissionPrompt } from "../support/helpers/permissions";

// The shipped stall threshold is two minutes, which no spec can wait out. `global-setup.ts`
// lowers it to 2s via `EXPO_PUBLIC_PASEO_STALL_THRESHOLD_MS`, which Metro inlines at bundle
// time — and it does so only for the desktop-runtime bundle, so this spec runs there alone.
test.skip(
  process.env.E2E_DESKTOP_RUNTIME !== "1",
  "needs the desktop-runtime bundle's lowered stall threshold",
);

// `WorkingActivity` ticks every 15s, so the label can appear up to a tick after the threshold.
const LABEL_TIMEOUT_MS = 40_000;
const TICK_MS = 15_000;

/**
 * These specs wait out real thresholds rather than faking a clock, so they are slow by design —
 * and tearing down a workspace whose turn is still running blocks the daemon for around half a
 * minute, which lands on whichever spec runs next. The generous budget is for that teardown, not
 * for the assertions.
 */
const SPEC_TIMEOUT_MS = 180_000;

test("surfaces a stalled turn in the working indicator", async ({ page }) => {
  test.setTimeout(SPEC_TIMEOUT_MS);

  // `stalled-stream` emits the turn's first chunk and then goes quiet for half an hour without
  // ending the turn — the only way to reach this state from a provider that otherwise streams
  // continuously.
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "turn-stall",
    title: "Stalled turn e2e",
    model: "stalled-stream",
    initialPrompt: "Go quiet after the first chunk.",
  });

  try {
    await openAgentRoute(page, workspace);
    await expectInlineWorkingIndicator(page);

    const stalled = page.getByTestId("turn-working-stalled");
    await expect(stalled).toBeVisible({ timeout: LABEL_TIMEOUT_MS });
    await expect(stalled).toHaveText(/no output for/i);

    // The label must advance, not freeze at whatever it read when it first appeared.
    const first = await stalled.innerText();
    await expect(async () => {
      expect(await stalled.innerText()).not.toBe(first);
    }).toPass({ timeout: TICK_MS * 3 });

    // Every slot is an addition, never a replacement: the row reads elapsed · tokens · stall.
    // The count is what tells the reader how much output an interrupt would throw away, so a
    // stalled turn must not hide it.
    await expect(page.getByTestId("turn-working-elapsed")).toBeVisible();
    await expect(page.getByTestId("turn-working-tokens")).toBeVisible();
  } finally {
    await workspace.cleanup();
  }
});

test("does not call a turn stalled while it waits on the user", async ({ page }) => {
  test.setTimeout(SPEC_TIMEOUT_MS);

  // The positive control lives in the test above: without it, "no label" here would be
  // indistinguishable from the feature being dead.
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "turn-stall-permission",
    title: "Permission-blocked turn e2e",
    model: "stalled-stream",
    initialPrompt: "emit a synthetic plan approval",
  });

  try {
    await openAgentRoute(page, workspace);
    await waitForPermissionPrompt(page);
    await expectInlineWorkingIndicator(page);

    // A turn blocked on the user is silent by design. Give it well past the lowered threshold
    // and a full tick, then assert the label never appeared.
    await page.waitForTimeout(TICK_MS + 5_000);
    await expect(page.getByTestId("turn-working-stalled")).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});

test("shows the running turn's token count beside the elapsed timer", async ({ page }) => {
  test.setTimeout(SPEC_TIMEOUT_MS);

  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "turn-tokens",
    title: "Turn tokens e2e",
    model: "one-minute-stream",
    initialPrompt: "Stream for a while.",
  });

  try {
    await openAgentRoute(page, workspace);
    await expectInlineWorkingIndicator(page);

    const tokens = page.getByTestId("turn-working-tokens");
    await expect(tokens).toBeVisible({ timeout: LABEL_TIMEOUT_MS });
    await expect(tokens).toHaveText(/tokens/i);
  } finally {
    await workspace.cleanup();
  }
});
