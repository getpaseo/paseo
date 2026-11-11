import { rename, mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { gotoAppShell, openSettings } from "./app";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { getServerId } from "./server-id";
import { expectSettingsHeader, openHostSection, openSettingsHost } from "./settings";

export type SpeechSiteLabel = "Speech-to-text" | "Listening" | "Speaking";
type SpeechSiteId = "dictation.stt" | "voiceMode.stt" | "voiceMode.tts";

export async function openVoiceSettings(page: Page): Promise<void> {
  const serverId = getServerId();
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHost(page, serverId);
  await openHostSection(page, serverId, "voice");
  await expectSettingsHeader(page, "Voice");
}

function speechSiteRow(page: Page, label: SpeechSiteLabel): Locator {
  return page.getByRole("button", { name: new RegExp(`^${label}, `) });
}

export async function expectSpeechSiteSummary(
  page: Page,
  label: SpeechSiteLabel,
  summary: string,
): Promise<void> {
  await expect(speechSiteRow(page, label)).toHaveAccessibleName(`${label}, ${summary}`);
}

/** Opens the provider sheet for one use site and returns it. */
export async function openSpeechSite(page: Page, label: SpeechSiteLabel): Promise<Locator> {
  await speechSiteRow(page, label).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText(label, { exact: true })).toBeVisible();
  return sheet;
}

export function providerOption(sheet: Locator, provider: "Local" | "OpenAI"): Locator {
  return sheet.getByRole("button", { name: provider, exact: true });
}

export function apiKeyInput(sheet: Locator): Locator {
  return sheet.getByRole("textbox", { name: "API key" });
}

export function baseUrlInput(sheet: Locator): Locator {
  return sheet.getByRole("textbox", { name: "Base URL" });
}

export async function saveSpeechSite(sheet: Locator): Promise<void> {
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
}

export async function expectSheetClosed(page: Page): Promise<void> {
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/** The speech site as the daemon reports it; the API key itself never leaves the daemon. */
export async function readSpeechSite(siteId: SpeechSiteId): Promise<Record<string, unknown>> {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  try {
    const { config } = await client.getDaemonConfig();
    const features = config.features as Record<string, Record<string, unknown>>;
    const [feature, site] = siteId.split(".");
    return features[feature][site] as Record<string, unknown>;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Puts a speech site back to the default provider so later tests start from a known state. */
export async function resetSpeechSite(siteId: SpeechSiteId): Promise<void> {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  try {
    const [feature, site] = siteId.split(".");
    await client.patchDaemonConfig({ features: { [feature]: { [site]: { provider: "local" } } } });
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Makes the daemon's config file unreadable for the duration of `run`. */
export async function withUnwritableDaemonConfig(run: () => Promise<void>): Promise<void> {
  const paseoHome = process.env.E2E_PASEO_HOME;
  if (!paseoHome) throw new Error("E2E_PASEO_HOME is required to break the daemon config");
  const configPath = path.join(paseoHome, "config.json");
  const asidePath = `${configPath}.aside`;
  await rename(configPath, asidePath);
  await mkdir(configPath);
  try {
    await run();
  } finally {
    await rmdir(configPath);
    await rename(asidePath, configPath);
  }
}
