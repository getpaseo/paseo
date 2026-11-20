import { expect, test } from "../support/fixtures";
import {
  apiKeyInput,
  baseUrlInput,
  expectSheetClosed,
  expectSpeechSiteSummary,
  openSpeechSite,
  openVoiceSettings,
  providerOption,
  readSpeechSite,
  resetSpeechSite,
  saveSpeechSite,
  withUnwritableDaemonConfig,
} from "../support/helpers/voice-settings";

// E2E daemons pin every speech provider to OpenAI through env vars so no test starts a model
// download. That makes the provider picker read-only here; the env key covers the key fallback.
const ENV_API_KEY = "sk-e2e-env-fallback";
const SAVED_API_KEY = "sk-e2e-saved-key";
const BASE_URL = "http://127.0.0.1:9/v1";

test.use({ e2eDaemonEnvironment: { OPENAI_API_KEY: ENV_API_KEY } });

test("configures an env-pinned OpenAI site and keeps the saved key on later saves", async ({
  page,
}) => {
  try {
    await openVoiceSettings(page);
    await expectSpeechSiteSummary(page, "Listening", "OpenAI · whisper-1");

    const sheet = await test.step("the env var decides the provider", async () => {
      const opened = await openSpeechSite(page, "Listening");
      await expect(opened.getByText("Set by PASEO_VOICE_STT_PROVIDER")).toBeVisible();
      await expect(providerOption(opened, "Local")).toBeDisabled();
      await expect(providerOption(opened, "OpenAI")).toHaveAttribute("aria-selected", "true");
      await expect(opened.getByText("Set by OPENAI_API_KEY")).toBeVisible();
      return opened;
    });

    await test.step("a saved key and base URL win over the env key", async () => {
      await apiKeyInput(sheet).fill(SAVED_API_KEY);
      await baseUrlInput(sheet).fill(BASE_URL);
      await saveSpeechSite(sheet);
      await expectSheetClosed(page);
      await expect
        .poll(() => readSpeechSite("voiceMode.stt"))
        .toMatchObject({ provider: "openai", hasApiKey: true, baseUrl: BASE_URL });
    });

    await test.step("reopening shows the key as saved without revealing it", async () => {
      const reopened = await openSpeechSite(page, "Listening");
      await expect(apiKeyInput(reopened)).toHaveValue("");
      await expect(apiKeyInput(reopened)).toHaveAttribute("placeholder", "Saved");
      await expect(reopened.getByText("Set by OPENAI_API_KEY")).toHaveCount(0);
      await expect(baseUrlInput(reopened)).toHaveValue(BASE_URL);
      await expect(reopened.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    });

    await test.step("clearing the base URL keeps the saved key", async () => {
      const sheetAgain = page.getByRole("dialog");
      await baseUrlInput(sheetAgain).fill("");
      await saveSpeechSite(sheetAgain);
      await expectSheetClosed(page);
      const site = await readSpeechSite("voiceMode.stt");
      expect(site).toMatchObject({ provider: "openai", hasApiKey: true });
      expect(site).not.toHaveProperty("baseUrl");
    });
  } finally {
    await resetSpeechSite("voiceMode.stt");
  }
});

test("a failed save keeps the sheet open with the user's input", async ({ page }) => {
  try {
    await openVoiceSettings(page);
    const sheet = await openSpeechSite(page, "Speaking");
    await baseUrlInput(sheet).fill(BASE_URL);

    await withUnwritableDaemonConfig(async () => {
      await saveSpeechSite(sheet);
      await expect(page.getByText(/^Unable to update voice settings: /)).toBeVisible();
    });

    await expect(baseUrlInput(sheet)).toHaveValue(BASE_URL);
    await saveSpeechSite(sheet);
    await expectSheetClosed(page);
    await expect
      .poll(() => readSpeechSite("voiceMode.tts"))
      .toMatchObject({ provider: "openai", baseUrl: BASE_URL });
  } finally {
    await resetSpeechSite("voiceMode.tts");
  }
});
