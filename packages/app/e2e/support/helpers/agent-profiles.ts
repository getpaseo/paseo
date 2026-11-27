import { expect, type Locator, type Page } from "@playwright/test";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { gotoAppShell, openSettings } from "./app";
import { connectDaemonClient } from "./daemon-client-loader";
import { getServerId } from "./server-id";
import { expectAppRoute } from "./route-assertions";
import { openSettingsHost } from "./settings";

// ─── Daemon-side seeding ───────────────────────────────────────────────────

interface AgentProfilesDaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  getDaemonConfig(): Promise<{ config: { agentProfiles?: AgentProfile[] } }>;
  patchDaemonConfig(config: {
    agentProfiles?: AgentProfile[];
    providers?: Record<string, Record<string, unknown>>;
    removeProviders?: string[];
  }): Promise<unknown>;
}

export interface HostSeed {
  /** Puts the host's config back the way the test found it and drops the client. */
  restore(): Promise<void>;
}

async function connectAgentProfilesClient(): Promise<AgentProfilesDaemonClient> {
  return connectDaemonClient<AgentProfilesDaemonClient>({ clientIdPrefix: "agent-profiles-e2e" });
}

/**
 * Writes profiles into host config directly. Journeys that are *about* the
 * settings UI create theirs through it; every other journey starts from a host
 * that already has them.
 */
export async function seedAgentProfiles(profiles: AgentProfile[]): Promise<HostSeed> {
  const client = await connectAgentProfilesClient();
  const previous = (await client.getDaemonConfig()).config.agentProfiles ?? [];
  await client.patchDaemonConfig({ agentProfiles: profiles });
  return {
    async restore() {
      await client.patchDaemonConfig({ agentProfiles: previous }).catch(() => undefined);
      await client.close().catch(() => undefined);
    },
  };
}

export async function stageLegacyFavoritesForHostMigration(
  page: Page,
  favorites: Array<{ provider: string; modelId: string }>,
): Promise<void> {
  const serverId = getServerId();
  await gotoAppShell(page);
  await page.evaluate(
    ({ favorites: storedFavorites, serverId: hostId }) => {
      const preferencesKey = "@paseo:create-agent-preferences";
      const raw = localStorage.getItem(preferencesKey);
      const preferences = raw ? JSON.parse(raw) : {};
      localStorage.setItem(
        preferencesKey,
        JSON.stringify({ ...preferences, favoriteModels: storedFavorites }),
      );
      localStorage.removeItem(`@paseo:legacy-favorites-to-agent-profiles:v1:${hostId}`);

      // Preserve this upgrade-shaped storage across the fixture's next-page
      // default seed; a reload is the startup boundary under test.
      const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
      if (nonce) {
        localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
      }
    },
    { favorites, serverId },
  );
  await page.reload();
}

export async function expectHostAgentProfiles(expected: AgentProfile[]): Promise<void> {
  const client = await connectAgentProfilesClient();
  try {
    await expect
      .poll(async () => (await client.getDaemonConfig()).config.agentProfiles ?? [], {
        timeout: 30_000,
      })
      .toEqual(expected);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export interface SeededProviderModel {
  id: string;
  label: string;
  description: string;
}

/**
 * Registers a second provider that reports a fixed catalog. The E2E daemon has
 * exactly one provider with models (`mock`), so nothing cross-provider can be
 * proven without one more.
 *
 * `extends: "mock"` is rejected — the config validator only accepts the six
 * shipped providers plus `acp`. Extending `claude` with a replacement `models`
 * list is what avoids running anything: replacement models skip catalog
 * discovery, and Claude's static modes mean the provider never spawns. The
 * command only has to resolve for the availability probe, hence `node`.
 * Providers with dynamic catalogs can pass a small RPC fixture as `command`.
 */
export async function seedModelProvider(input: {
  id: string;
  label: string;
  models: SeededProviderModel[];
  extends?: "claude" | "pi";
  command?: string[];
}): Promise<HostSeed> {
  const client = await connectAgentProfilesClient();
  await client.patchDaemonConfig({
    providers: {
      [input.id]: {
        extends: input.extends ?? "claude",
        label: input.label,
        description: `${input.label} test provider`,
        enabled: true,
        command: input.command ?? ["node"],
        models: input.models,
      },
    },
  });
  return {
    async restore() {
      await client.patchDaemonConfig({ removeProviders: [input.id] }).catch(() => undefined);
      await client.close().catch(() => undefined);
    },
  };
}

// ─── Settings: navigation ──────────────────────────────────────────────────

/** Reach agent profiles through the same visible Settings path a person uses. */
export async function openAgentProfileSettings(page: Page): Promise<void> {
  const serverId = getServerId();
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHost(page, serverId);
  await page.getByRole("button", { name: "Agent profiles", exact: true }).click();
  await expectAppRoute(page, buildSettingsHostSectionRoute(serverId, "agent-profiles"));
  await expect(page.getByTestId("agent-profiles-card")).toBeVisible({ timeout: 30_000 });
}

/** Reach agent profiles on a compact viewport so Open project -> Settings -> Agent profiles are pushed. */
export async function openCompactAgentProfileSettings(page: Page): Promise<void> {
  const serverId = getServerId();
  await gotoAppShell(page);
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  const settingsButton = page.locator('[data-testid="sidebar-settings"]:visible').first();
  await expect(settingsButton).toBeVisible({ timeout: 30_000 });
  await settingsButton.click();
  await expect(page).toHaveURL(/\/settings(?:\?|$)/, { timeout: 30_000 });
  await page.getByRole("button", { name: "Agent profiles", exact: true }).click();
  await expectAppRoute(page, buildSettingsHostSectionRoute(serverId, "agent-profiles"));
  await expect(page.getByTestId("agent-profiles-card")).toBeVisible({ timeout: 30_000 });
}

export async function expectNoAgentProfiles(page: Page): Promise<void> {
  const card = page.getByTestId("agent-profiles-card");
  await expect(card.getByTestId("agent-profiles-empty")).toBeVisible();
  await expect(card.getByRole("button", { name: "New profile", exact: true })).toBeVisible();
}

// ─── Settings: the profile list ────────────────────────────────────────────

export function agentProfileRow(page: Page, name: string): Locator {
  return page
    .locator('[data-testid^="agent-profile-row-"]')
    .filter({ has: page.getByText(name, { exact: true }) });
}

export async function expectAgentProfile(
  page: Page,
  expected: { name: string; tags: string[]; notes?: string },
): Promise<void> {
  const row = agentProfileRow(page, expected.name);
  await expect(row).toBeVisible({ timeout: 30_000 });
  for (const tag of expected.tags) {
    await expect(row).toContainText(tag);
  }
  if (expected.notes !== undefined) {
    await expect(row.getByText(expected.notes, { exact: true })).toBeVisible();
  }
}

export async function expectAgentProfileTagsGone(
  page: Page,
  input: { name: string; tags: string[] },
): Promise<void> {
  const row = agentProfileRow(page, input.name);
  for (const tag of input.tags) {
    await expect(row).not.toContainText(tag);
  }
}

/** Order is what the user sees, so it is measured on screen rather than in the DOM. */
export async function expectAgentProfileOrder(page: Page, names: string[]): Promise<void> {
  await expect
    .poll(
      async () => {
        const measured = await Promise.all(
          names.map(async (name) => ({ name, top: await boxTop(agentProfileRow(page, name)) })),
        );
        return measured.sort((a, b) => a.top - b.top).map((entry) => entry.name);
      },
      { timeout: 15_000 },
    )
    .toEqual(names);
}

async function openRowActionMenu(page: Page, name: string): Promise<void> {
  const row = agentProfileRow(page, name);
  await row.hover();
  const trigger = row.locator('[data-testid^="agent-profile-menu-"]');
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await trigger.click();
}

export async function moveAgentProfileUp(page: Page, name: string): Promise<void> {
  await openRowActionMenu(page, name);
  await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
}

export async function moveAgentProfileDown(page: Page, name: string): Promise<void> {
  await openRowActionMenu(page, name);
  await page.getByRole("menuitem", { name: "Move down", exact: true }).click();
}

/**
 * The remove confirmation is `window.confirm` on browser web, so the dialog is
 * consumed here — and its text is asserted, since naming the profile is the
 * whole point of confirming.
 */
export async function removeAgentProfile(page: Page, name: string): Promise<void> {
  const dialogMessage = page.waitForEvent("dialog").then(async (dialog) => {
    const message = dialog.message();
    await dialog.accept();
    return message;
  });
  await openRowActionMenu(page, name);
  await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
  expect(await dialogMessage).toContain(`Remove "${name}"?`);
  await expect(agentProfileRow(page, name)).toHaveCount(0, { timeout: 30_000 });
}

// ─── Settings: the inspector drawer / edit sheet ───────────────────────────

export interface AgentProfileDraft {
  name?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  mode?: string;
  notes?: string;
}

function editSurface(page: Page): Locator {
  return page.locator(
    '[data-testid="agent-profile-drawer"], [data-testid="agent-profile-edit-modal"]',
  );
}

async function chooseSelectFieldOption(
  page: Page,
  input: { field: "model" | "mode" | "thinking"; option: string },
): Promise<void> {
  await editSurface(page).getByTestId(`agent-profile-${input.field}-trigger`).click();
  const option = page
    .getByTestId("combobox-desktop-container")
    .getByRole("button", { name: input.option, exact: true });
  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click();
}

async function ensureCustomizeExpanded(surface: Locator): Promise<void> {
  const toggle = surface.getByTestId("agent-profile-customize-toggle");
  if ((await toggle.count()) > 0 && (await toggle.isVisible())) {
    await toggle.click();
  }
}

async function chooseProfileModel(
  page: Page,
  input: { provider?: string; model?: string },
): Promise<void> {
  await editSurface(page).getByTestId("agent-profile-model-trigger").click();
  const container = page.getByTestId("combobox-desktop-container");
  await expect(container).toBeVisible({ timeout: 30_000 });
  if (input.provider) {
    const providerRow = container.getByRole("button", {
      name: new RegExp(escapeForRegex(input.provider)),
    });
    if ((await providerRow.count()) > 0 && (await providerRow.first().isVisible())) {
      await providerRow.first().click();
    }
  }
  const targetLabel = input.model ?? input.provider;
  if (targetLabel) {
    const option = container
      .getByRole("button", { name: new RegExp(escapeForRegex(targetLabel)) })
      .first();
    await expect(option).toBeVisible({ timeout: 30_000 });
    await option.click();
  }
}

async function fillAgentProfileForm(page: Page, draft: AgentProfileDraft): Promise<void> {
  const surface = editSurface(page);
  // Model first: CombinedModelSelector sets provider + model and auto-suggests defaults.
  if (draft.model !== undefined || draft.provider !== undefined) {
    await chooseProfileModel(page, { provider: draft.provider, model: draft.model });
  }
  if (draft.name !== undefined) {
    await surface.getByRole("textbox", { name: "Name", exact: true }).fill(draft.name);
  }
  if (draft.thinking !== undefined || draft.mode !== undefined || draft.notes !== undefined) {
    await ensureCustomizeExpanded(surface);
  }
  if (draft.mode !== undefined) {
    await chooseSelectFieldOption(page, { field: "mode", option: draft.mode });
  }
  if (draft.thinking !== undefined) {
    const thinkingContainer = surface.getByTestId("agent-profile-thinking-field");
    const segmentButton = thinkingContainer.getByRole("button", {
      name: draft.thinking,
      exact: true,
    });
    if ((await segmentButton.count()) > 0) {
      await segmentButton.click();
    } else {
      await chooseSelectFieldOption(page, { field: "thinking", option: draft.thinking });
    }
  }
  if (draft.notes !== undefined) {
    await surface.getByRole("textbox", { name: "When to use", exact: true }).fill(draft.notes);
  }
}

async function saveAgentProfile(page: Page): Promise<void> {
  await page.getByTestId("agent-profile-save-button").click();
  await expect(editSurface(page)).toHaveCount(0, { timeout: 30_000 });
}

export async function createAgentProfile(page: Page, draft: AgentProfileDraft): Promise<void> {
  await page.getByTestId("agent-profiles-add-button").click();
  await expect(editSurface(page)).toBeVisible({ timeout: 30_000 });
  await fillAgentProfileForm(page, draft);
  await saveAgentProfile(page);
}

export async function createAgentProfileFromEmptyState(
  page: Page,
  draft: AgentProfileDraft,
): Promise<void> {
  await page
    .getByTestId("agent-profiles-card")
    .getByRole("button", { name: "New profile", exact: true })
    .click();
  await expect(editSurface(page)).toBeVisible({ timeout: 30_000 });
  await fillAgentProfileForm(page, draft);
  await saveAgentProfile(page);
}

export async function editAgentProfile(
  page: Page,
  name: string,
  changes: AgentProfileDraft,
): Promise<void> {
  await agentProfileRow(page, name).click();
  await expect(editSurface(page)).toBeVisible({ timeout: 30_000 });
  await fillAgentProfileForm(page, changes);
  await saveAgentProfile(page);
}

export async function openAgentProfileEditor(page: Page, name: string): Promise<void> {
  await agentProfileRow(page, name).click();
  await expect(editSurface(page)).toBeVisible({ timeout: 30_000 });
}

export async function openCreateAgentProfileEditor(page: Page): Promise<void> {
  await page.getByTestId("agent-profiles-add-button").click();
  await expect(editSurface(page)).toBeVisible({ timeout: 30_000 });
}

export async function fillAgentProfileName(page: Page, name: string): Promise<void> {
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
}

export async function expectAgentProfileNameDraft(page: Page, name: string): Promise<void> {
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);
}

export async function toggleAgentProfileCustomize(page: Page): Promise<void> {
  await page.getByTestId("agent-profile-customize-toggle").click();
}

export async function fillAgentProfileNotes(page: Page, notes: string): Promise<void> {
  await page.getByRole("textbox", { name: "When to use", exact: true }).fill(notes);
}

export async function expectAgentProfileNotesDraft(page: Page, notes: string): Promise<void> {
  await expect(page.getByRole("textbox", { name: "When to use", exact: true })).toHaveValue(notes);
}

export async function saveOpenAgentProfile(page: Page): Promise<void> {
  await saveAgentProfile(page);
}

export async function duplicateOpenAgentProfileWithConfirm(
  page: Page,
  decision: "accept" | "dismiss",
): Promise<void> {
  const dialogMessage = page.waitForEvent("dialog").then(async (dialog) => {
    const message = dialog.message();
    if (decision === "accept") {
      await dialog.accept();
    } else {
      await dialog.dismiss();
    }
    return message;
  });
  await page.getByTestId("agent-profile-drawer-more").click();
  await page.getByTestId("agent-profile-drawer-duplicate").click();
  expect(await dialogMessage).toMatch(/discard|unsaved/i);
}

export async function openEditProfileFromModelRow(
  page: Page,
  input: { provider: string; modelId: string },
): Promise<void> {
  const row = modelRow(page, input);
  await row.hover();
  const editButton = pickerViewport(page).getByTestId(
    `model-edit-profile-${input.provider}-${input.modelId}`,
  );
  await expect(editButton).toBeVisible({ timeout: 30_000 });
  await editButton.click();
  await expect(page.getByTestId("agent-profile-edit-modal")).toBeVisible({ timeout: 30_000 });
}

export async function removeOpenModalAgentProfileWithConfirm(
  page: Page,
  decision: "accept" | "dismiss",
): Promise<void> {
  const dialogMessage = page.waitForEvent("dialog").then(async (dialog) => {
    const message = dialog.message();
    if (decision === "accept") {
      await dialog.accept();
    } else {
      await dialog.dismiss();
    }
    return message;
  });
  await page.getByTestId("agent-profile-modal-remove-button").click();
  expect(await dialogMessage).toMatch(/remove/i);
}

export async function switchSettingsSectionWithConfirm(
  page: Page,
  sectionName: string,
  decision: "accept" | "dismiss",
): Promise<void> {
  const dialogMessage = page.waitForEvent("dialog").then(async (dialog) => {
    const message = dialog.message();
    if (decision === "accept") {
      await dialog.accept();
    } else {
      await dialog.dismiss();
    }
    return message;
  });
  await page.getByRole("button", { name: sectionName, exact: true }).click();
  expect(await dialogMessage).toMatch(/discard|unsaved/i);
}

export async function browserBackWithConfirm(
  page: Page,
  decision: "accept" | "dismiss",
): Promise<void> {
  const dialogMessage = page.waitForEvent("dialog").then(async (dialog) => {
    const message = dialog.message();
    if (decision === "accept") {
      await dialog.accept();
    } else {
      await dialog.dismiss();
    }
    return message;
  });
  await page.goBack();
  expect(await dialogMessage).toMatch(/discard|unsaved/i);
}

export async function browserHistoryJumpWithConfirm(
  page: Page,
  delta: number,
  decision: "accept" | "dismiss",
): Promise<void> {
  const dialogMessage = page.waitForEvent("dialog").then(async (dialog) => {
    const message = dialog.message();
    if (decision === "accept") {
      await dialog.accept();
    } else {
      await dialog.dismiss();
    }
    return message;
  });
  await page.evaluate((step) => window.history.go(step), delta);
  expect(await dialogMessage).toMatch(/discard|unsaved/i);
}

/** Opens the inspector for a profile purely to read back what it stored. */
export async function expectAgentProfileForm(
  page: Page,
  name: string,
  expected: { provider?: string; model?: string; mode?: string; notes?: string },
): Promise<void> {
  await agentProfileRow(page, name).click();
  const surface = editSurface(page);
  await expect(surface).toBeVisible({ timeout: 30_000 });
  await expect(surface.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);
  const notesHint = surface.getByTestId("agent-profile-notes-field-hint");
  await expect(notesHint).toHaveText("Tells agents when to pick this profile");
  expect(await notesHint.evaluate((element) => getComputedStyle(element).webkitLineClamp)).not.toBe(
    "1",
  );
  if (expected.model) {
    await expect(surface.getByTestId("agent-profile-model-trigger")).toContainText(expected.model);
  } else if (expected.provider) {
    await expect(surface.getByTestId("agent-profile-model-trigger")).toContainText(
      expected.provider,
    );
  }
  if (expected.provider) {
    await expect(surface).toContainText(expected.provider);
  }
  if (expected.mode) {
    await expect(surface.getByTestId("agent-profile-mode-trigger")).toContainText(expected.mode);
  }
  if (expected.notes !== undefined) {
    await expect(surface.getByRole("textbox", { name: "When to use", exact: true })).toHaveValue(
      expected.notes,
    );
  }
  await surface.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editSurface(page)).toHaveCount(0, { timeout: 30_000 });
}

// ─── The model picker ──────────────────────────────────────────────────────

/** Desktop web renders the model browser inside the combobox popover. */
function pickerViewport(page: Page): Locator {
  return page.getByTestId("combobox-desktop-container");
}

export async function openModelPicker(page: Page): Promise<void> {
  await page.getByTestId("combined-model-selector").filter({ visible: true }).first().click();
  await expect(pickerViewport(page)).toBeVisible({ timeout: 30_000 });
}

export async function closeModelPicker(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(pickerViewport(page)).toHaveCount(0, { timeout: 30_000 });
}

export function profilePickerRow(page: Page, name: string): Locator {
  return pickerViewport(page)
    .locator('[data-testid^="model-profile-row-"]')
    .filter({ hasText: name });
}

/**
 * Profiles are pinned above the provider list, so "pinned" is an ordering claim:
 * the profile row's top edge sits above every provider row's.
 */
export async function expectProfilePinnedAboveProviders(
  page: Page,
  input: { name: string; summary: string },
): Promise<void> {
  const viewport = pickerViewport(page);
  await expect(viewport.getByText("Profiles", { exact: true })).toBeVisible({ timeout: 30_000 });
  const row = profilePickerRow(page, input.name);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText(input.summary, { exact: true })).toBeVisible();

  const profileTop = await boxTop(row);
  const providerRows = viewport.locator('[data-testid^="model-provider-"]');
  await expect(providerRows.first()).toBeVisible();
  const providerCount = await providerRows.count();
  for (let index = 0; index < providerCount; index += 1) {
    expect(profileTop).toBeLessThan(await boxTop(providerRows.nth(index)));
  }
}

export async function expectProfileVisibleForProvider(
  page: Page,
  input: { name: string; summary: string },
): Promise<void> {
  const viewport = pickerViewport(page);
  await expect(viewport.getByText("Profiles", { exact: true })).toBeVisible({ timeout: 30_000 });
  const row = profilePickerRow(page, input.name);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText(input.summary, { exact: true })).toBeVisible();
}

export async function expectProfileEditIsPencilOnly(page: Page): Promise<void> {
  const viewport = pickerViewport(page);
  await expect(
    viewport.getByRole("button", { name: "Edit agent profiles", exact: true }),
  ).toBeVisible();
  await expect(viewport.getByText("Edit", { exact: true })).toHaveCount(0);
}

export async function expectAgentProfilesEmptyPrompt(page: Page): Promise<void> {
  const viewport = pickerViewport(page);
  await expect(viewport.getByText("Profiles", { exact: true })).toHaveCount(0);
  await expect(
    viewport.getByRole("button", { name: "Edit agent profiles", exact: true }),
  ).toHaveCount(0);
  await expect(viewport.getByRole("button", { name: "Create profile", exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

export async function expectProfileEditTooltip(page: Page): Promise<void> {
  const edit = pickerViewport(page).getByRole("button", {
    name: "Edit agent profiles",
    exact: true,
  });
  await edit.hover();
  await expect(page.getByText("Edit agent profiles", { exact: true })).toBeVisible();
}

export async function openAgentProfilesFromEmptyPrompt(page: Page): Promise<void> {
  await pickerViewport(page).getByRole("button", { name: "Create profile", exact: true }).click();
  await expect(page.getByTestId("agent-profiles-card")).toBeVisible({ timeout: 30_000 });
}

async function boxTop(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("Expected a laid-out element to measure");
  }
  return box.y;
}

export async function searchModelPicker(page: Page, query: string): Promise<void> {
  await pickerViewport(page).getByTestId("model-search-input").fill(query);
}

/** A search lists matching profiles first, then the matching models under their own heading. */
export async function expectProfileSearchResult(
  page: Page,
  input: { name: string; model?: { provider: string; modelId: string } },
): Promise<void> {
  const viewport = pickerViewport(page);
  const row = profilePickerRow(page, input.name);
  await expect(row).toBeVisible({ timeout: 30_000 });
  if (!input.model) {
    await expect(viewport.getByText("Models", { exact: true })).toHaveCount(0);
    return;
  }
  const matchedModel = modelRow(page, input.model);
  await expect(viewport.getByText("Models", { exact: true })).toBeVisible();
  await expect(matchedModel).toBeVisible();
  expect(await boxTop(row)).toBeLessThan(await boxTop(matchedModel));
}

/** Wheel-scrolls the picker the way a pointer user would until the profile row is on screen. */
export async function expectProfileReachableByScrolling(page: Page, name: string): Promise<void> {
  const row = profilePickerRow(page, name);
  await expect(row).toBeAttached({ timeout: 30_000 });
  const box = await pickerViewport(page).boundingBox();
  if (!box) throw new Error("model picker has no layout box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(async () => {
    await page.mouse.wheel(0, 400);
    await expect(row).toBeInViewport({ timeout: 500 });
  }).toPass({ timeout: 15_000 });
}

export async function applyProfileFromPicker(page: Page, name: string): Promise<void> {
  await profilePickerRow(page, name).click();
  await expect(pickerViewport(page)).toHaveCount(0, { timeout: 30_000 });
}

/**
 * Applying a profile materializes it and forgets it: nothing in the root view
 * claims selection. Model rows do carry `aria-selected`, so a count of zero here
 * is the absence of a checkmark, not the absence of the attribute everywhere.
 */
export async function expectNothingSelectedInPickerRoot(page: Page): Promise<void> {
  await expect(pickerViewport(page).locator("[aria-selected]")).toHaveCount(0);
}

export async function expectAgentProfilesEditShortcut(page: Page): Promise<void> {
  await expect(
    pickerViewport(page).getByRole("button", { name: "Edit agent profiles", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
}

export async function drillIntoProvider(page: Page, providerId: string): Promise<void> {
  await pickerViewport(page).getByTestId(`model-provider-${providerId}`).click();
}

export async function expectModelRowSelected(
  page: Page,
  input: { provider: string; modelId: string },
): Promise<void> {
  await expect(
    pickerViewport(page).getByTestId(`model-row-${input.provider}-${input.modelId}`),
  ).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
}

function modelRow(page: Page, input: { provider: string; modelId: string }): Locator {
  return pickerViewport(page).getByTestId(`model-row-${input.provider}-${input.modelId}`);
}

/**
 * A model row's profile action is its own button. On web, a button inside the
 * row's button is invalid HTML that React reports on every render.
 */
export async function expectModelRowProfileActionBesideRow(
  page: Page,
  input: { provider: string; modelId: string },
): Promise<void> {
  const row = modelRow(page, input);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(pickerViewport(page).locator("button button")).toHaveCount(0);
  await expect(row.getByRole("button")).toHaveCount(0);
}

/**
 * The hover-revealed plus on an unprofiled model row saves the profile,
 * selects the model immediately, closes the picker, and surfaces an Edit / Undo toast.
 */
export async function expectCreateProfileFromModelRow(
  page: Page,
  input: { provider: string; modelId: string; modelLabel: string },
): Promise<void> {
  const action = pickerViewport(page).getByTestId(
    `model-create-profile-${input.provider}-${input.modelId}`,
  );
  // Until its row is hovered the plus is invisible, so a tap on its spot reaches the row.
  await expect(action).toHaveCSS("pointer-events", "none");
  await modelRow(page, input).hover();
  await expect(action).toHaveCSS("pointer-events", "auto");
  await action.click();

  const toast = page.getByTestId("model-profile-created-toast");
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await expect(toast).toContainText(input.modelLabel);

  // Undo removes the newly saved profile from the toast.
  await toast.getByTestId("model-profile-created-undo").click();
  await expect(toast).toHaveCount(0, { timeout: 30_000 });
}

export async function selectModelRow(
  page: Page,
  input: { provider: string; modelId: string },
): Promise<void> {
  await modelRow(page, input).click();
}

/**
 * Opens a provider on a slow machine and clicks a model row before the list has
 * finished laying out, holding the button as long as a person does.
 */
export async function clickModelRowWhileProviderOpens(
  page: Page,
  input: { provider: string; modelLabel: string },
): Promise<void> {
  const viewport = pickerViewport(page);
  await drillIntoProvider(page, input.provider);
  const rowBox = await viewport.getByText(input.modelLabel, { exact: true }).boundingBox();
  if (!rowBox) throw new Error(`Model row ${input.modelLabel} has no box`);
  await viewport.getByRole("button", { name: "Back", exact: true }).click();

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 10 });
  try {
    await drillIntoProvider(page, input.provider);
    await page.mouse.click(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2, {
      delay: 150,
    });
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach();
  }
}

/** Scrolling a provider's model list with the wheel leaves typing and Enter in the search field. */
export async function expectModelListScrollKeepsSearchFocused(page: Page): Promise<void> {
  const search = pickerViewport(page).getByTestId("model-search-input");
  const list = pickerViewport(page).getByTestId("compact-model-list");
  await expect(search).toBeFocused();
  await list.hover();
  await page.mouse.wheel(0, 200);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(search).toBeFocused();
}

// ─── Cross-provider model search ───────────────────────────────────────────

export async function searchAllModels(page: Page, query: string): Promise<void> {
  const input = page.getByTestId("model-search-all-input");
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill(query);
}

export async function expectModelSearchResult(
  page: Page,
  expected: { provider: string; modelId: string; providerLabel: string; modelLabel: string },
): Promise<void> {
  const row = pickerViewport(page).getByTestId(
    `model-row-${expected.provider}-${expected.modelId}`,
  );
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText(expected.modelLabel, { exact: true })).toBeVisible();
  await expect(
    row.getByText(new RegExp(`^${escapeForRegex(expected.providerLabel)}\\b`)),
  ).toBeVisible();
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Search results replace the whole root view, pinned profiles included. */
export async function expectPinnedProfilesHidden(page: Page): Promise<void> {
  await expect(pickerViewport(page).locator('[data-testid^="model-profile-row-"]')).toHaveCount(0);
}

export async function expectModelSearchEmptyState(page: Page, query: string): Promise<void> {
  const empty = page.getByTestId("model-search-empty");
  await expect(empty).toBeVisible({ timeout: 30_000 });
  await expect(empty.getByText(`No models match "${query}"`, { exact: true })).toBeVisible();
}

export async function readModelPickerHeight(page: Page): Promise<number> {
  const box = await pickerViewport(page).boundingBox();
  if (!box) {
    throw new Error("Expected the model picker to be laid out");
  }
  return box.height;
}

export async function readModelPickerWidth(page: Page): Promise<number> {
  const box = await pickerViewport(page).boundingBox();
  if (!box) {
    throw new Error("Expected the model picker to be laid out");
  }
  return box.width;
}

export async function expectModelPickerHeight(page: Page, expectedHeight: number): Promise<void> {
  await expect.poll(() => readModelPickerHeight(page)).toBe(expectedHeight);
}

export async function expectModelPickerWidth(page: Page, expectedWidth: number): Promise<void> {
  await expect.poll(() => readModelPickerWidth(page)).toBe(expectedWidth);
}

export async function expectSearchResultsVirtualized(
  page: Page,
  input: { provider: string; total: number },
): Promise<void> {
  const mountedRows = pickerViewport(page).locator(`[data-testid^="model-row-${input.provider}-"]`);
  await expect.poll(() => mountedRows.count()).toBeGreaterThan(0);
  expect(await mountedRows.count()).toBeLessThan(input.total);
}

// ─── Composer agent controls ───────────────────────────────────────────────

export async function expectComposerModel(page: Page, modelLabel: string): Promise<void> {
  await expect(
    page.getByRole("button", { name: `Select model (${modelLabel})`, exact: true }),
  ).toBeVisible({ timeout: 30_000 });
}

export async function expectComposerMode(page: Page, modeLabel: string): Promise<void> {
  await expect(
    page.getByRole("button", { name: `Select agent mode (${modeLabel})`, exact: true }).first(),
  ).toBeVisible({ timeout: 30_000 });
}

/** The composer never shows the profile's name — a profile is not a selection. */
export async function expectComposerDoesNotName(page: Page, profileName: string): Promise<void> {
  await expect(
    page.locator('[data-testid="message-input-root"]:visible').getByText(profileName),
  ).toHaveCount(0);
}
