import { expect, test, waitForHydration, type Locator, type Page } from "./fixtures";

const desktopName =
  "Paseo desktop app with coding agents, a conversation, and a code diff open side by side";

/** Opens the homepage once it has hydrated, so the router's scroll reset cannot undo a later scroll. */
async function openHomepage(page: Page, window = { width: 1512, height: 930 }) {
  await page.setViewportSize(window);
  await page.goto("/");
  await waitForHydration(page);
}

/** The scene advances at most 64 ms per frame. Drive its frames independently of CI paint speed. */
async function openHomepageWithSceneClock(
  page: Page,
  viewport?: { width: number; height: number },
) {
  await page.clock.install();
  await openHomepage(page, viewport);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
}

async function centerMockup(mockup: Locator) {
  await mockup.evaluate((element) =>
    element.scrollIntoView({ block: "center", behavior: "instant" }),
  );
}

async function finishPanelSwap(page: Page, mockup: Locator, outgoingPanel: Locator) {
  await expect
    .poll(async () => {
      await page.clock.runFor(250);
      // Playwright's clock drives JavaScript frames. Native animations use the document timeline.
      await mockup.evaluate((element) => {
        for (const animation of element.getAnimations({ subtree: true })) {
          if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
        }
      });
      return outgoingPanel.count();
    })
    .toBe(0);
}

async function viewPhones(page: Page) {
  await page.getByRole("img", { name: "Paseo agent chat", exact: true }).scrollIntoViewIfNeeded();
}

async function expectScreenContentInsidePhone(page: Page, name: string, time: string) {
  const phone = page.getByRole("img", { name, exact: true });
  const clock = phone.getByText(time, { exact: true });
  await expect(clock).toBeVisible();
  await expect(async () => {
    const frame = await phone.boundingBox();
    const content = await clock.boundingBox();
    expect(frame).not.toBeNull();
    expect(content).not.toBeNull();
    if (!frame || !content) throw new Error("Phone screen is not rendered");
    expect(content.x).toBeGreaterThanOrEqual(frame.x);
    expect(content.y).toBeGreaterThanOrEqual(frame.y);
    expect(content.x + content.width).toBeLessThanOrEqual(frame.x + frame.width);
    expect(content.y + content.height).toBeLessThanOrEqual(frame.y + frame.height);
  }).toPass({ timeout: 5000 });
}

async function cornerProportion(mockup: Locator) {
  return mockup.evaluate((element) => {
    const radius = getComputedStyle(element).borderTopLeftRadius.split(" ")[0];
    if (radius.endsWith("%")) return Number.parseFloat(radius) / 100;
    return Number.parseFloat(radius) / element.getBoundingClientRect().width;
  });
}

async function resizeToPhone(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("img", { name: desktopName, exact: true }).scrollIntoViewIfNeeded();
}

test("the three phone mockups show their screen content", async ({ page }) => {
  await openHomepage(page);
  await viewPhones(page);
  await expectScreenContentInsidePhone(page, "Paseo workspace drawer", "18:54");
  await expectScreenContentInsidePhone(page, "Paseo agent chat", "18:53");
  await expectScreenContentInsidePhone(page, "Paseo diff view", "18:55");
});

test("desktop mockup corners shrink in proportion on a phone", async ({ page }) => {
  await openHomepage(page);
  const mockup = page.getByRole("img", { name: desktopName, exact: true });
  const desktopCorner = await cornerProportion(mockup);
  expect(desktopCorner).toBeGreaterThan(0);
  await resizeToPhone(page);
  await expect.poll(() => cornerProportion(mockup)).toBeCloseTo(desktopCorner, 3);
});

/** Each hero pill and one thing only its finished scene draws. */
const HERO_SCENES = [
  { pill: "Orchestration", shows: "Pi · GLM-5.2" },
  { pill: "Remote", shows: "Tailscale" },
  { pill: "Code review", shows: "Feedback sent to Codex" },
  { pill: "Pull requests", shows: "https://github.com/getpaseo/paseo/pull/3981" },
  { pill: "Plugins", shows: "app-tests (macos)" },
];

/** Clicks a hero pill until its scene starts. A click before hydration selects nothing. */
async function playScene(page: Page, pill: string, opensWith: Locator) {
  await expect(async () => {
    await page.getByRole("button", { name: pill, exact: true }).click();
    await expect(opensWith).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
}

test("each hero pill shows its finished scene when motion is reduced", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openHomepage(page);
  const mockup = page.getByRole("img", { name: desktopName, exact: true });
  await mockup.scrollIntoViewIfNeeded();
  // Last to first, so the opening scene is also reached by a click.
  for (const scene of HERO_SCENES.toReversed()) {
    await playScene(page, scene.pill, mockup.getByText(scene.shows, { exact: true }).first());
  }
});

test("the hero opens on orchestration across providers and machines", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openHomepage(page);
  const mockup = page.getByRole("img", { name: desktopName, exact: true });
  await expect(page.getByRole("button", { name: "Orchestration", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  for (const agent of ["Codex · GPT-5.6-Sol", "OpenCode · Kimi K3", "Pi · GLM-5.2"]) {
    await expect(mockup.getByText(agent, { exact: true })).toBeVisible();
  }
  // The task on another machine carries that host's badge in its tool call and its subagent row.
  for (const remoteTask of ["OpenCode · fix/menu-bar-icon", "OpenCode · Kimi K3"]) {
    const row = mockup.getByText(remoteTask, { exact: true }).locator("xpath=..");
    await expect(row.getByText("mac-mini", { exact: true })).toBeVisible();
  }
});

test("the orchestration scene plays from an empty chat to the open roster of subagents", async ({
  page,
}) => {
  await openHomepageWithSceneClock(page);
  const mockup = page.getByRole("img", { name: desktopName, exact: true });
  const composer = mockup.getByText("Message the agent, tag @files, or use /commands and /skills");
  await playScene(page, "Orchestration", composer);
  await expect(mockup.getByText("Create agent", { exact: true })).toHaveCount(0);
  await expect(mockup.getByText("3 subagents", { exact: true })).toHaveCount(0);

  // The orchestrator lists the issues and the agent profiles, launches three agents and says so,
  // then the pointer clicks the pill and the roster opens. Ten seconds outlasts the scene.
  await page.clock.runFor(10_000);
  await expect(mockup.getByText("3 subagents", { exact: true })).toBeVisible();
  await expect(mockup.getByText("gh issue list --label ready", { exact: true })).toBeVisible();
  await expect(mockup.getByText("List agent profiles", { exact: true })).toBeVisible();
  await expect(
    mockup.getByText(
      "I will launch the UI agent on your mac-mini, because that issue is specific to macOS.",
    ),
  ).toBeVisible();
  await expect(mockup.getByText("Create agent", { exact: true })).toHaveCount(3);
  await expect(
    mockup.getByText("All three are launched. Paseo will notify me when each one finishes."),
  ).toBeVisible();
  await expect(mockup.getByText("Pi · GLM-5.2", { exact: true })).toBeVisible();
});

test("the opening scene waits until most of the mockup is on screen", async ({ page }) => {
  await openHomepageWithSceneClock(page);
  const mockup = page.getByRole("img", { name: desktopName, exact: true });
  const request = mockup.getByText("Fix the issues labeled ready, one worktree each.");
  await expect(mockup).not.toBeInViewport({ ratio: 0.6 });

  // A scene that started at load sends the request within three seconds.
  await page.clock.runFor(4500);
  await expect(request).toHaveCount(0);

  await centerMockup(mockup);
  await expect(mockup).toBeInViewport({ ratio: 0.6 });
  await page.clock.runFor(4500);
  await expect(request).toBeVisible();
});

test("the opening scene starts in a window shorter than most of the mockup", async ({ page }) => {
  await openHomepageWithSceneClock(page, { width: 1400, height: 320 });
  const mockup = page.getByRole("img", { name: desktopName, exact: true });
  const request = mockup.getByText("Fix the issues labeled ready, one worktree each.");
  await centerMockup(mockup);
  await expect(mockup).toBeInViewport();
  await expect(mockup).not.toBeInViewport({ ratio: 0.6 });
  await page.clock.runFor(4500);
  await expect(request).toBeVisible();
});

test("the plugins scene installs the panel, then changes it on request", async ({ page }) => {
  await openHomepageWithSceneClock(page);
  const mockup = page.getByRole("img", { name: desktopName, exact: true });
  const changesPanel = mockup.getByText("Uncommitted", { exact: true });
  const pluginPanel = mockup.getByText("Recently merged", { exact: true });
  const failingCheck = mockup.getByText("app-tests (macos)", { exact: true });
  await playScene(page, "Plugins", page.getByRole("button", { name: "Plugins", pressed: true }));
  await expect(changesPanel).toBeVisible();
  await expect(pluginPanel).toHaveCount(0);

  // Installing the plugin swaps the docked panel for the one the agent built.
  await page.clock.runFor(5500);
  await expect(pluginPanel).toBeVisible();
  await finishPanelSwap(page, mockup, changesPanel);
  await expect(failingCheck).toHaveCount(0);

  // The second request reloads the plugin and the open panel lists the failing check.
  await page.clock.runFor(6000);
  await expect(failingCheck).toBeVisible();
  await expect(
    mockup.getByText("paseo plugin reload release-radar", { exact: true }),
  ).toBeVisible();
});

test("the code review scene comments on a line and sends the feedback to an agent", async ({
  page,
}) => {
  await openHomepage(page);
  const mockup = page.getByRole("img", { name: desktopName, exact: true });
  const comment = mockup.getByText("Add “write”. The agent edits files too.", { exact: true });
  const sendFeedback = mockup.getByText("Send feedback (1)", { exact: true });
  await playScene(
    page,
    "Code review",
    page.getByRole("button", { name: "Code review", pressed: true }),
  );
  await expect(comment).toHaveCount(0);

  // The pointer opens the editor on a line, and the typed comment is saved under that line.
  await expect(sendFeedback).toBeVisible({ timeout: 10_000 });
  await expect(comment).toBeVisible();

  // Send feedback asks which agent, and the sent comment leaves the diff.
  await expect(mockup.getByText("Claude Code", { exact: true })).toHaveCount(2, {
    timeout: 10_000,
  });
  await expect(mockup.getByText("Feedback sent to Codex", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(sendFeedback).toHaveCount(0);
  await expect(comment).toHaveCount(0);
});

test("picking a scene brings the pills and the whole mockup on screen", async ({ page }) => {
  await openHomepage(page);
  const mockup = page.getByRole("img", { name: desktopName, exact: true });
  await expect(mockup).not.toBeInViewport({ ratio: 0.9 });

  await playScene(page, "Remote", page.getByRole("button", { name: "Remote", pressed: true }));
  await expect(mockup).toBeInViewport({ ratio: 0.99 });
  await expect(page.getByRole("button", { name: "Remote", exact: true })).toBeInViewport({
    ratio: 1,
  });
});

test("picking a scene in a window too short for the mockup keeps the pills on screen", async ({
  page,
}) => {
  await openHomepage(page);
  await page.setViewportSize({ width: 1280, height: 600 });
  const mockup = page.getByRole("img", { name: desktopName, exact: true });
  await expect(mockup).not.toBeInViewport();

  await playScene(page, "Remote", page.getByRole("button", { name: "Remote", pressed: true }));
  await expect(mockup).toBeInViewport({ ratio: 0.7 });
  await expect(page.getByRole("button", { name: "Remote", exact: true })).toBeInViewport({
    ratio: 1,
  });
});

test("picking a scene while the hero is still sliding in keeps the pills on screen", async ({
  page,
}) => {
  // Reduced motion makes the scroll instant, so the test does not wait for one to settle.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openHomepage(page, { width: 1280, height: 700 });
  const mockup = page.getByRole("img", { name: desktopName, exact: true });
  await playScene(page, "Remote", page.getByRole("button", { name: "Remote", pressed: true }));

  // The hero slides up 40px as it enters. The test waits for that to end, puts the same 40px back
  // on the container, picks a scene, and lets the slide end again. A click during a real slide
  // does the same, but only inside the first second after load.
  const sliding = page
    .getByRole("button", { name: "Remote", exact: true })
    .locator("xpath=../../../..");
  await expect(sliding).toHaveCSS("transform", "none");
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(mockup).not.toBeInViewport({ ratio: 0.99 });
  const slideBy = (pixels: number) =>
    sliding.evaluate((container, y) => {
      container.style.transform = y === 0 ? "none" : `translateY(${y}px)`;
    }, pixels);

  const codeReview = page.getByRole("button", { name: "Code review", exact: true });
  await slideBy(40);
  await codeReview.click();
  await slideBy(0);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(codeReview).toBeInViewport({ ratio: 1 });
});

test("the remote scene lists hosts with how each connects and its round trip time", async ({
  page,
}) => {
  await openHomepage(page);
  const mockup = page.getByRole("img", { name: desktopName, exact: true });
  await expect(async () => {
    await page.getByRole("button", { name: "Remote", exact: true }).click();
    await expect(mockup.getByText("Hosts", { exact: true })).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
  for (const fact of ["Local", "Relay", "Tailscale", "SSH", "38ms", "mo@workstation"]) {
    await expect(mockup.getByText(fact, { exact: true })).toBeVisible();
  }
});

/** Opacity as rendered: the element's own times every ancestor's. */
async function renderedOpacity(locator: Locator) {
  return locator.evaluate((element) => {
    let opacity = 1;
    for (let node: Element | null = element; node; node = node.parentElement) {
      opacity *= Number.parseFloat(getComputedStyle(node).opacity);
    }
    return opacity;
  });
}

test("the plugin demo plays through to the panel the agent built", async ({ page }) => {
  await openHomepage(page);
  const builtPanelRow = page.getByText("Add Gruvbox theme", { exact: true });
  expect(await renderedOpacity(builtPanelRow)).toBe(0);

  // Hydration can reset the scroll position, so keep the demo in view until it finishes.
  const heading = page.getByRole("heading", { name: "Ask Paseo to change Paseo" });
  await expect(async () => {
    await heading.scrollIntoViewIfNeeded();
    expect(await renderedOpacity(builtPanelRow)).toBe(1);
  }).toPass({ timeout: 15_000 });
  expect(await renderedOpacity(page.getByText("Review queue is in your sidebar."))).toBe(1);
});

test("the plugin demo shows its finished state when motion is reduced", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openHomepage(page);
  const builtPanelRow = page.getByText("Add Gruvbox theme", { exact: true });
  const panel = builtPanelRow.locator("xpath=ancestor::div[contains(@class, 'md:border-l')]");
  const heading = page.getByRole("heading", { name: "Ask Paseo to change Paseo" });

  await expect(async () => {
    await heading.scrollIntoViewIfNeeded();
    expect(await renderedOpacity(builtPanelRow)).toBe(1);
  }).toPass({ timeout: 2_000 });
  expect(await panel.evaluate((element) => getComputedStyle(element).transform)).toBe("none");
});
