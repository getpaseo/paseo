import { describe, expect, it } from "vitest";
import type { SpeechSettingsPatch } from "@getpaseo/protocol/speech/rpc-schemas";
import { openSpeechProviderForm, type SpeechProviderFormSnapshot } from "./speech-provider-form";

function open(overrides: Partial<SpeechProviderFormSnapshot> = {}) {
  return openSpeechProviderForm({
    siteId: "voiceMode.stt",
    site: { provider: "local" },
    envOverrides: {},
    ...overrides,
  });
}

async function savedPatch(
  model: ReturnType<typeof open>,
): Promise<SpeechSettingsPatch | undefined> {
  let sent: SpeechSettingsPatch | undefined;
  const result = await model.save(async (patch) => {
    sent = patch;
  });
  expect(result).toEqual({ status: "saved" });
  return sent;
}

describe("speech provider form", () => {
  it("edits and clears local STT language from the saved snapshot", async () => {
    const form = open({ site: { provider: "local", language: "fr" } });
    expect(form.getState()).toMatchObject({ language: "fr", canSave: false });
    form.setLanguage(" de ");
    expect(await savedPatch(form)).toEqual({
      voiceMode: { stt: { provider: "local", language: "de" } },
    });
    const clear = open({ site: { provider: "local", language: "fr" } });
    clear.setLanguage("");
    expect(await savedPatch(clear)).toEqual({
      voiceMode: { stt: { provider: "local", language: null } },
    });
  });

  it("keeps STT language when switching either provider", async () => {
    for (const provider of ["local", "openai"] as const) {
      const form = open({
        site:
          provider === "local"
            ? { provider, language: "fr" }
            : { provider, hasApiKey: false, language: "fr" },
      });
      form.setProvider(provider === "local" ? "openai" : "local");
      expect(await savedPatch(form)).toEqual({
        voiceMode: { stt: { provider: provider === "local" ? "openai" : "local", language: "fr" } },
      });
    }
  });

  it("keeps env-controlled language read-only after switching providers", async () => {
    const form = open({
      site: { provider: "local", language: "fr" },
      envOverrides: { "features.voiceMode.stt.language": "PASEO_VOICE_LANGUAGE" },
    });
    form.setProvider("openai");
    expect(form.getState().fields.language).toEqual({
      envVar: "PASEO_VOICE_LANGUAGE",
      readOnly: true,
    });
    expect(await savedPatch(form)).toEqual({ voiceMode: { stt: { provider: "openai" } } });
  });

  it("switches a site to OpenAI with a key and base URL", async () => {
    const form = open();
    expect(form.getState().canSave).toBe(false);

    form.setProvider("openai");
    form.setApiKey(" sk-test ");
    form.setBaseUrl("http://127.0.0.1:9999/v1");

    expect(await savedPatch(form)).toEqual({
      voiceMode: {
        stt: { provider: "openai", apiKey: "sk-test", baseUrl: "http://127.0.0.1:9999/v1" },
      },
    });
  });

  it("re-saves OpenAI settings without touching the saved key", async () => {
    const form = open({
      siteId: "dictation.stt",
      site: { provider: "openai", hasApiKey: true, baseUrl: "https://a.example/v1" },
    });
    expect(form.getState()).toMatchObject({ apiKey: "", hasSavedApiKey: true, canSave: false });

    form.setOpenAiModel("gpt-4o-transcribe");
    form.setBaseUrl("");

    expect(await savedPatch(form)).toEqual({
      dictation: { stt: { provider: "openai", model: "gpt-4o-transcribe", baseUrl: null } },
    });
  });

  it("selects a local model", async () => {
    const form = open({
      siteId: "dictation.stt",
      site: { provider: "local", model: "whisper-tiny" },
    });
    form.setLocalModel("whisper-tiny");
    expect(form.getState().canSave).toBe(false);

    form.setLocalModel("whisper-base");

    expect(await savedPatch(form)).toEqual({
      dictation: { stt: { provider: "local", model: "whisper-base" } },
    });
  });

  it("locks fields an env var decides and keeps fallback fields editable", async () => {
    const form = open({
      site: { provider: "openai", hasApiKey: false },
      envOverrides: {
        "features.voiceMode.stt.provider": "PASEO_VOICE_STT_PROVIDER",
        "features.voiceMode.stt.model": "STT_MODEL",
        "features.voiceMode.stt.apiKey": "OPENAI_API_KEY",
      },
    });
    expect(form.getState().fields).toMatchObject({
      provider: { envVar: "PASEO_VOICE_STT_PROVIDER", readOnly: true },
      model: { envVar: "STT_MODEL", readOnly: true },
      apiKey: { envVar: "OPENAI_API_KEY", readOnly: false },
      baseUrl: { envVar: null, readOnly: false },
    });

    form.setProvider("local");
    form.setOpenAiModel("gpt-4o-transcribe");
    form.setApiKey("sk-saved");

    expect(form.getState().provider).toBe("openai");
    expect(await savedPatch(form)).toEqual({
      voiceMode: { stt: { provider: "openai", apiKey: "sk-saved" } },
    });
  });

  it("does not apply the saved provider's env vars to another provider", () => {
    const form = open({
      envOverrides: { "features.voiceMode.stt.model": "PASEO_VOICE_LOCAL_STT_MODEL" },
    });
    expect(form.getState().fields.model.readOnly).toBe(true);

    form.setProvider("openai");

    expect(form.getState().fields.model).toEqual({ envVar: null, readOnly: false });
  });

  it("keeps the input and allows a retry after a failed save", async () => {
    const form = open({ siteId: "voiceMode.tts" });
    form.setProvider("openai");
    form.setApiKey("sk-test");
    form.setVoice("nova");
    const failure = new Error("disk full");

    const result = await form.save(async () => {
      expect(form.getState()).toMatchObject({ saving: true, canSave: false });
      throw failure;
    });

    expect(result).toEqual({ status: "failed", error: failure });
    expect(form.getState()).toMatchObject({
      provider: "openai",
      apiKey: "sk-test",
      voice: "nova",
      saving: false,
      canSave: true,
    });
    expect(await savedPatch(form)).toEqual({
      voiceMode: { tts: { provider: "openai", apiKey: "sk-test", voice: "nova" } },
    });
  });
});
