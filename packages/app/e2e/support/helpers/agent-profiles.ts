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
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expectAppRoute(page, buildSettingsHostSectionRoute(serverId, "agents"));
  await expect(page.getByTestId("agent-profiles-card")).toBeVisible({ timeout: 30_000 });
}

export async function expectNoAgentProfiles(page: Page): Promise<void> {
  const card = page.getByTestId("agent-profiles-card");
  await expect(card.getByTestId("agent-profiles-empty")).toBeVisible();
  await expect(card.getByRole("button", { name: "New profile", exact: true })).toBeVisible();
}

// ─── Settings: the profile list ────────────────────────────────────────────

export function agentProfileRow(page: Page, name: string): Locator {
  return page.locator('[data-testid^="agent-profile-row-"]').filter({ hasText: name });
}

export async function expectAgentProfile(
  page: Page,
  expected: { name: string; tags: string[]; notes?: string },
): Promise<void> {
  const row = agentProfileRow(page, expected.name);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText(expected.tags.join(" · "), { exact: true })).toBeVisible();
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
    await expect(row.getByText(tag, { exact: true })).toHaveCount(0);
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

export async function moveAgentProfileUp(page: Page, name: string): Promise<void> {
  await agentProfileRow(page, name).getByRole("button", { name: "Move up", exact: true }).click();
}

export async function moveAgentProfileDown(page: Page, name: string): Promise<void> {
  await agentProfileRow(page, name).getByRole("button", { name: "Move down", exact: true }).click();
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
  await agentProfileRow(page, name).getByRole("button", { name: "Remove", exact: true }).click();
  expect(await dialogMessage).toContain(`Remove "${name}"?`);
  await expect(agentProfileRow(page, name)).toHaveCount(0, { timeout: 30_000 });
}

// ─── Settings: the edit modal ──────────────────────────────────────────────

export interface AgentProfileDraft {
  name?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  mode?: string;
  notes?: string;
}

function editModal(page: Page): Locator {
  return page.getByTestId("agent-profile-edit-modal");
}

async function chooseSelectFieldOption(
  page: Page,
  input: { field: "provider" | "model" | "mode" | "thinking"; option: string },
): Promise<void> {
  await editModal(page).getByTestId(`agent-profile-${input.field}-trigger`).click();
  const option = page
    .getByTestId("combobox-desktop-container")
    .getByRole("button", { name: input.option, exact: true });
  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click();
  await expect(
    page.getByRole("button", { name: `${capitalize(input.field)} (${input.option})` }),
  ).toBeVisible({ timeout: 30_000 });
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function fillAgentProfileForm(page: Page, draft: AgentProfileDraft): Promise<void> {
  const modal = editModal(page);
  if (draft.name !== undefined) {
    await modal.getByRole("textbox", { name: "Name", exact: true }).fill(draft.name);
  }
  // Provider first: it resets every provider-scoped field below it.
  if (draft.provider !== undefined) {
    await chooseSelectFieldOption(page, { field: "provider", option: draft.provider });
  }
  // Thinking after model: thinking levels hang off the model, and switching the
  // model drops a level the new one does not offer.
  if (draft.model !== undefined) {
    await chooseSelectFieldOption(page, { field: "model", option: draft.model });
  }
  if (draft.thinking !== undefined) {
    await chooseSelectFieldOption(page, { field: "thinking", option: draft.thinking });
  }
  if (draft.mode !== undefined) {
    await chooseSelectFieldOption(page, { field: "mode", option: draft.mode });
  }
  if (draft.notes !== undefined) {
    await modal.getByRole("textbox", { name: "Notes for agents", exact: true }).fill(draft.notes);
  }
}

async function saveAgentProfile(page: Page): Promise<void> {
  await editModal(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(editModal(page)).toHaveCount(0, { timeout: 30_000 });
}

export async function createAgentProfile(page: Page, draft: AgentProfileDraft): Promise<void> {
  await page.getByRole("button", { name: "Add agent profile", exact: true }).click();
  await expect(editModal(page)).toBeVisible({ timeout: 30_000 });
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
  await expect(editModal(page)).toBeVisible({ timeout: 30_000 });
  await fillAgentProfileForm(page, draft);
  await saveAgentProfile(page);
}

export async function editAgentProfile(
  page: Page,
  name: string,
  changes: AgentProfileDraft,
): Promise<void> {
  await agentProfileRow(page, name)
    .getByRole("button", { name: "Edit profile", exact: true })
    .click();
  await expect(editModal(page)).toBeVisible({ timeout: 30_000 });
  await fillAgentProfileForm(page, changes);
  await saveAgentProfile(page);
}

/** Opens the modal for a profile purely to read back what it stored. */
export async function expectAgentProfileForm(
  page: Page,
  name: string,
  expected: { provider?: string; model?: string; mode?: string; notes?: string },
): Promise<void> {
  await agentProfileRow(page, name)
    .getByRole("button", { name: "Edit profile", exact: true })
    .click();
  const modal = editModal(page);
  await expect(modal).toBeVisible({ timeout: 30_000 });
  await expect(modal.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(name);
  for (const [field, value] of Object.entries(expected)) {
    if (field === "notes") {
      await expect(
        modal.getByRole("textbox", { name: "Notes for agents", exact: true }),
      ).toHaveValue(value);
      continue;
    }
    await expect(
      modal.getByRole("button", { name: `${capitalize(field)} (${value})` }),
    ).toBeVisible({ timeout: 30_000 });
  }
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editModal(page)).toHaveCount(0, { timeout: 30_000 });
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
