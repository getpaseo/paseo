import { expect, type Locator, type Page } from "@playwright/test";

interface CommandCenterScrollSample {
  scrollTop: number;
  firstResultTop: number;
  viewportTop: number;
}

interface CommandCenterScrollObservation {
  done: boolean;
  samples: CommandCenterScrollSample[];
}

type ScrollOracleWindow = Window & {
  __commandCenterScrollObservation?: CommandCenterScrollObservation;
};

export async function observeCommandCenterScroll(page: Page): Promise<void> {
  await page.evaluate(() => {
    const oracleWindow = window as ScrollOracleWindow;
    oracleWindow.__commandCenterScrollObservation = { done: false, samples: [] };

    const discoverPanel = new MutationObserver(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="command-center-panel"]');
      const firstResult = panel?.querySelector<HTMLElement>('[role="button"]');
      if (!panel || !firstResult) return;

      let viewport = firstResult.parentElement;
      while (viewport && viewport !== panel && viewport.scrollHeight <= viewport.clientHeight) {
        viewport = viewport.parentElement;
      }
      if (!viewport || viewport === panel) return;

      discoverPanel.disconnect();
      let frame = 0;
      const sample = () => {
        const observation = oracleWindow.__commandCenterScrollObservation;
        if (!observation) return;
        const firstResultBounds = firstResult.getBoundingClientRect();
        const viewportBounds = viewport.getBoundingClientRect();
        observation.samples.push({
          scrollTop: viewport.scrollTop,
          firstResultTop: firstResultBounds.top,
          viewportTop: viewportBounds.top,
        });
        frame += 1;
        if (frame < 60) {
          requestAnimationFrame(sample);
          return;
        }
        observation.done = true;
      };
      requestAnimationFrame(sample);
    });

    discoverPanel.observe(document.body, { childList: true, subtree: true });
  });
}

export async function openCommandCenterWithKeyboard(page: Page): Promise<Locator> {
  await expect(page.getByTestId("sidebar-search")).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Meta+K");
  const panel = page.getByTestId("command-center-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

export async function expectCommandCenterToRemainAtTheTop(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as ScrollOracleWindow).__commandCenterScrollObservation?.done === true,
  );
  const samples = await page.evaluate(
    () => (window as ScrollOracleWindow).__commandCenterScrollObservation?.samples ?? [],
  );

  expect(samples.length).toBeGreaterThan(0);
  expect(
    Math.min(...samples.map((sample) => sample.firstResultTop - sample.viewportTop)),
  ).toBeGreaterThanOrEqual(0);
  expect(Math.max(...samples.map((sample) => sample.scrollTop))).toBe(0);
}

export async function expectPrimaryCommandCenterActions(panel: Locator): Promise<void> {
  const expectedActions = [
    { title: "New workspace", shortcut: "⌘N" },
    { title: "Import session" },
    { title: "History" },
    { title: "Schedules" },
    { title: "Settings", shortcut: "⌘," },
    { title: "Keyboard shortcuts", shortcut: "?" },
  ] as const;

  for (const action of expectedActions) {
    const row = panel.getByRole("button").filter({ hasText: action.title });
    await expect(row).toBeVisible();
    if ("shortcut" in action) await expect(row).toContainText(action.shortcut);
  }

  await expect(panel.getByRole("button").filter({ hasText: "Add project" })).toHaveCount(0);
  await expect(panel.getByRole("button").filter({ hasText: "Home" })).toHaveCount(0);

  const input = panel.getByTestId("command-center-input");
  await input.fill("add project");
  await expect(panel.getByRole("button").filter({ hasText: "Add project" })).toBeVisible();
  await expect(panel.getByRole("button").filter({ hasText: "Home" })).toHaveCount(0);
  await input.fill("home");
  await expect(panel.getByRole("button").filter({ hasText: "Home" })).toBeVisible();
  await expect(panel.getByRole("button").filter({ hasText: "Add project" })).toHaveCount(0);
  await input.fill("import");
  await expect(panel.getByRole("button").filter({ hasText: "Import session" })).toBeVisible();
  await expect(panel.getByRole("button").filter({ hasText: "Home" })).toHaveCount(0);
  await input.fill("");
}

export async function expectVisibleKeyboardNavigationNotToScroll(
  page: Page,
  panel: Locator,
): Promise<void> {
  for (let index = 0; index < 4; index += 1) await page.keyboard.press("ArrowDown");

  const scrollSamples = await panel
    .getByRole("button")
    .first()
    .evaluate(async (firstResult) => {
      let viewport = firstResult.parentElement;
      while (viewport && viewport.scrollHeight <= viewport.clientHeight) {
        viewport = viewport.parentElement;
      }
      if (!viewport) throw new Error("Could not find the command center scroll viewport");

      const samples: number[] = [];
      for (let frame = 0; frame < 20; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        samples.push(viewport.scrollTop);
      }
      return samples;
    });

  expect(Math.max(...scrollSamples)).toBe(0);
}

export async function expectWorkspaceResultsToBeLimitedUntilSearch(panel: Locator): Promise<void> {
  const workspaces = panel.locator(
    '[data-testid^="command-center-workspace-"]:not([data-testid="command-center-workspace-subtitle"])',
  );
  const distinctWorkspaceCount = async () =>
    new Set(
      await workspaces.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-testid")),
      ),
    ).size;

  await expect.poll(distinctWorkspaceCount).toBe(5);

  await panel.getByTestId("command-center-input").fill("Command Center Scroll");
  await expect.poll(distinctWorkspaceCount).toBe(9);
}

export async function expectTightTwoLineResultSpacing(
  panel: Locator,
  title: string,
): Promise<void> {
  const row = panel.getByText(title, { exact: true }).locator("..");
  const titleTop = await row
    .getByText(title, { exact: true })
    .evaluate((element) => element.getBoundingClientRect().top);
  const subtitleTop = await row
    .getByTestId("command-center-workspace-subtitle")
    .evaluate((element) => element.getBoundingClientRect().top);
  expect(subtitleTop - titleTop).toBeLessThanOrEqual(18);
}
