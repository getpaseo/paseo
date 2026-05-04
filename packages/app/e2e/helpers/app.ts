import { expect, type Page } from "@playwright/test";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const gotoAppShell = async (page: Page) => {
  await page.goto("/");
};

export const gotoHome = async (page: Page) => {
  await gotoAppShell(page);
  const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
  const entryButton = page
    .getByText("Add a project", { exact: true })
    .or(page.getByText("Add project", { exact: true }))
    .or(page.getByText("New agent", { exact: true }))
    .first();

  await expect
    .poll(
      async () =>
        (await composer.isVisible().catch(() => false)) ||
        (await entryButton.isVisible().catch(() => false)),
      { timeout: 10_000 },
    )
    .toBe(true);

  if (!(await composer.isVisible().catch(() => false))) {
    await entryButton.click();
  }

  await expect(composer).toBeVisible({ timeout: 30_000 });
};

export const openSettings = async (page: Page) => {
  // Navigate through the real app control so route changes stay aligned with UI behavior.
  const settingsButton = page.locator('[data-testid="sidebar-settings"]:visible').first();
  await expect(settingsButton).toBeVisible();
  await settingsButton.click();
  await expect(page).toHaveURL(/\/settings\/general$/);
};

export const setWorkingDirectory = async (page: Page, directory: string) => {
  const workingDirectorySelect = page
    .locator('[data-testid="working-directory-select"]:visible')
    .first();
  await expect(workingDirectorySelect).toBeVisible({ timeout: 30000 });

  const legacyInput = page.getByRole("textbox", { name: "/path/to/project" }).first();
  const directorySearchInput = page.getByRole("textbox", { name: /search directories/i }).first();
  const worktreePicker = page.getByTestId("worktree-attach-picker");
  const worktreeSheetTitle = page.getByText("Select worktree", { exact: true }).first();
  const closeBottomSheet = async () => {
    const bottomSheetBackdrop = page.getByRole("button", { name: "Bottom sheet backdrop" }).first();
    const bottomSheetHandle = page.getByRole("slider", { name: "Bottom sheet handle" }).first();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await bottomSheetBackdrop.isVisible())) {
        return;
      }
      await bottomSheetBackdrop.click({ force: true });
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(200);
    }
    if (await bottomSheetBackdrop.isVisible()) {
      const box = await bottomSheetHandle.boundingBox();
      if (box) {
        const startX = box.x + box.width / 2;
        const startY = box.y + box.height / 2;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX, startY + 400);
        await page.mouse.up();
        await page.waitForTimeout(200);
      }
    }
  };
  const closeWorktreeSheetIfOpen = async () => {
    if (!(await worktreeSheetTitle.isVisible()) && !(await worktreePicker.isVisible())) {
      return;
    }
    const attachToggle = page.getByTestId("worktree-attach-toggle");
    if (await attachToggle.isVisible()) {
      await attachToggle.click({ force: true });
      await page.waitForTimeout(200);
    }
    await closeBottomSheet();
  };

  await closeWorktreeSheetIfOpen();

  const pickerInputVisible = async () =>
    (await directorySearchInput.isVisible().catch(() => false)) ||
    (await legacyInput.isVisible().catch(() => false));

  if (!(await pickerInputVisible())) {
    await closeBottomSheet();
    await workingDirectorySelect.click({ force: true });
    if (!(await pickerInputVisible())) {
      await closeBottomSheet();
      await workingDirectorySelect.click({ force: true });
    }
    await expect.poll(async () => pickerInputVisible(), { timeout: 10000 }).toBe(true);
  }

  const trimmedDirectory = directory.replace(/\/+$/, "");
  const activeInput = (await directorySearchInput.isVisible().catch(() => false))
    ? directorySearchInput
    : legacyInput;

  await activeInput.fill(trimmedDirectory);

  if (activeInput === directorySearchInput) {
    // Combobox custom rows can be either plain path labels or prefixed labels.
    const plainOption = page
      .getByText(new RegExp(`^${escapeRegex(trimmedDirectory)}$`, "i"))
      .first();
    const prefixedUseOption = page
      .getByText(new RegExp(`^Use "${escapeRegex(trimmedDirectory)}"$`, "i"))
      .first();

    if (await plainOption.isVisible().catch(() => false)) {
      await plainOption.click({ force: true });
    } else if (await prefixedUseOption.isVisible().catch(() => false)) {
      await prefixedUseOption.click({ force: true });
    } else {
      // Fallback: accept highlighted option (directory suggestion).
      await activeInput.press("Enter");
    }
  } else {
    // Legacy path picker fallback.
    await activeInput.press("Enter");
  }

  // Wait for picker to close.
  await expect(activeInput).not.toBeVisible({ timeout: 10000 });

  const directoryCandidates = new Set<string>([trimmedDirectory]);
  if (trimmedDirectory.startsWith("/var/")) {
    directoryCandidates.add(`/private${trimmedDirectory}`);
  }
  if (trimmedDirectory.startsWith("/private/var/")) {
    directoryCandidates.add(trimmedDirectory.replace(/^\/private/, ""));
  }
  const basename = trimmedDirectory.split("/").findLast(Boolean) ?? trimmedDirectory;

  await expect
    .poll(
      async () => {
        const text = await workingDirectorySelect.innerText().catch(() => "");
        if (text.includes(basename)) return true;
        for (const candidate of directoryCandidates) {
          if (text.includes(candidate)) return true;
        }
        return false;
      },
      { timeout: 30000 },
    )
    .toBe(true);
};

export const ensureHostSelected = async (page: Page) => {
  const input = page.getByRole("textbox", { name: "Message agent..." });
  await expect(input).toBeVisible();

  if (await input.isEditable()) {
    return;
  }

  const selectHostLabel = page.getByText("Select host", { exact: true });
  if (await selectHostLabel.isVisible()) {
    await selectHostLabel.click();

    // We enforce a single seeded daemon, so the option should be unambiguous.
    const localhostOption = page.getByText("localhost", { exact: true }).first();
    const daemonIdOption = page
      .getByText(process.env.E2E_SERVER_ID ?? "srv_e2e_test_daemon", { exact: true })
      .first();

    if (await localhostOption.isVisible()) {
      await localhostOption.click();
    } else {
      await expect(daemonIdOption).toBeVisible();
      await daemonIdOption.click();
    }
  }

  await expect(input).toBeEditable();
};

export const createAgent = async (page: Page, message: string) => {
  const input = page.getByRole("textbox", { name: "Message agent..." });
  await expect(input).toBeEditable();
  await preferFastThinkingOption(page);
  await input.fill(message);
  await input.press("Enter");

  // The composer may remain on the draft screen briefly while the initial run starts,
  // so assert the user-visible result instead of forcing one route shape here.
  await expect(page).toHaveURL(/\/(workspace|agent|new-agent)(\/|$|\?)/, { timeout: 30000 });
  await expect(page.getByText(message, { exact: true }).first()).toBeVisible({
    timeout: 30000,
  });
};

async function preferFastThinkingOption(page: Page): Promise<void> {
  const providerTrigger = page
    .locator(
      '[data-testid="agent-provider-selector"]:visible, [data-testid="draft-provider-select"]:visible',
    )
    .first();
  if (await providerTrigger.isVisible().catch(() => false)) {
    const providerText = ((await providerTrigger.innerText().catch(() => "")) ?? "").trim();
    if (!/codex/i.test(providerText)) {
      return;
    }
  }

  const thinkingTrigger = page.getByTestId("agent-thinking-selector").first();
  if (!(await thinkingTrigger.isVisible().catch(() => false))) {
    return;
  }

  const currentThinkingLabel = ((await thinkingTrigger.innerText().catch(() => "")) ?? "")
    .trim()
    .toLowerCase();
  if (/\b(low|minimal|off)\b/.test(currentThinkingLabel)) {
    return;
  }

  await thinkingTrigger.click();
  const menu = page.getByTestId("agent-thinking-menu").first();
  if (!(await menu.isVisible().catch(() => false))) {
    return;
  }

  const preferredLabels = ["low", "minimal", "off", "medium"];
  let selected = false;
  for (const label of preferredLabels) {
    const option = menu
      .getByRole("button", { name: new RegExp(`^${escapeRegex(label)}$`, "i") })
      .first();
    if (await option.isVisible().catch(() => false)) {
      await option.click({ force: true });
      selected = true;
      break;
    }
  }

  if (!selected) {
    const options = menu.getByRole("button");
    const count = await options.count();
    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);
      const label = ((await option.innerText().catch(() => "")) ?? "").trim();
      if (!label) {
        continue;
      }
      if (label.toLowerCase() === currentThinkingLabel) {
        continue;
      }
      await option.click({ force: true });
      selected = true;
      break;
    }
  }

  if (!selected) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return;
  }

  await expect(menu).not.toBeVisible({ timeout: 5000 });
}

export interface AgentConfig {
  directory: string;
  provider?: string;
  model?: string;
  mode?: string;
  prompt: string;
}

export const selectProvider = async (page: Page, provider: string) => {
  const normalizedProvider = provider.trim();
  if (!normalizedProvider) {
    throw new Error("Provider must be a non-empty string.");
  }

  const providerTrigger = page
    .locator(
      '[data-testid="agent-provider-selector"]:visible, [data-testid="draft-provider-select"]:visible',
    )
    .first();
  if (
    await providerTrigger
      .getByText(new RegExp(`^${escapeRegex(normalizedProvider)}$`, "i"))
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    return;
  }

  if (await providerTrigger.isVisible().catch(() => false)) {
    await providerTrigger.click();
  } else {
    const providerLabel = page.getByText("PROVIDER", { exact: true }).first();
    await expect(providerLabel).toBeVisible();
    await providerLabel.click();
  }

  const dialog = page.getByRole("dialog").last();
  const searchInput = dialog.getByRole("textbox", { name: /search provider/i }).first();
  if (await searchInput.isVisible().catch(() => false)) {
    await searchInput.fill(normalizedProvider);
  }

  const option = dialog.getByText(new RegExp(`^${escapeRegex(normalizedProvider)}$`, "i")).first();
  await expect(option).toBeVisible();
  await option.click();
};

export const selectModel = async (page: Page, model: string) => {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    throw new Error("Model must be a non-empty string.");
  }

  const modelTrigger = page
    .locator(
      '[data-testid="agent-model-selector"]:visible, [data-testid="draft-model-select"]:visible',
    )
    .first();
  if (
    await modelTrigger
      .getByText(new RegExp(`^${escapeRegex(normalizedModel)}$`, "i"))
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    return;
  }

  if (await modelTrigger.isVisible().catch(() => false)) {
    await modelTrigger.click();
  } else {
    const modelLabel = page.getByText("MODEL", { exact: true }).first();
    await expect(modelLabel).toBeVisible();
    await modelLabel.click();
  }

  // Wait for the model dropdown to open
  const searchInput = page.getByRole("textbox", { name: /search model/i });
  await expect(searchInput).toBeVisible({ timeout: 10000 });

  // Type to search/filter models
  await searchInput.fill(normalizedModel);

  const dialog = page.getByRole("dialog");
  const exactOption = dialog
    .getByText(new RegExp(`^${escapeRegex(normalizedModel)}$`, "i"))
    .first();
  const exactVisible = await exactOption.isVisible().catch(() => false);
  if (exactVisible) {
    await exactOption.click({ force: true });
  } else {
    // Modern labels include version suffixes (for example "Haiku 4.5"), so
    // select the first filtered result using keyboard confirm.
    await searchInput.press("Enter");
  }

  // Wait for dropdown to close
  if (await searchInput.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  await expect(searchInput).not.toBeVisible({ timeout: 5000 });
};

export const selectMode = async (page: Page, mode: string) => {
  const modeTrigger = page
    .locator(
      '[data-testid="agent-mode-selector"]:visible, [data-testid="draft-mode-select"]:visible',
    )
    .first();
  if (await modeTrigger.isVisible().catch(() => false)) {
    await modeTrigger.click();
  } else {
    const modeLabel = page.getByText("MODE", { exact: true }).first();
    await expect(modeLabel).toBeVisible();
    await modeLabel.click();
  }

  // Wait for the mode dropdown to open
  const searchInput = page.getByRole("textbox", { name: /search mode/i });
  await expect(searchInput).toBeVisible({ timeout: 10000 });

  // Type to filter modes
  await searchInput.fill(mode);

  const dialog = page.getByRole("dialog");
  const option = dialog.getByText(new RegExp(`^${escapeRegex(mode)}$`, "i")).first();
  await expect(option).toBeVisible();
  await option.click({ force: true });

  // Wait for dropdown to close
  await expect(searchInput).not.toBeVisible({ timeout: 5000 });
};

export const createAgentWithConfig = async (page: Page, config: AgentConfig) => {
  await gotoHome(page);
  await ensureHostSelected(page);
  await setWorkingDirectory(page, config.directory);

  if (config.provider) {
    await selectProvider(page, config.provider);
  }

  if (config.model) {
    await selectModel(page, config.model);
  }

  if (config.mode) {
    await selectMode(page, config.mode);
  }

  await createAgent(page, config.prompt);
};

export const createAgentInRepo = async (
  page: Page,
  config: Pick<AgentConfig, "directory" | "prompt">,
) => {
  await gotoHome(page);
  await ensureHostSelected(page);
  await setWorkingDirectory(page, config.directory);
  await createAgent(page, config.prompt);
};
