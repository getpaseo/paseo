import { describe, expect, test } from "vitest";

import { PersistedConfigSchema } from "../../../persisted-config.js";
import { resolveOpenAiSpeechConfig } from "./config.js";

describe("resolveOpenAiSpeechConfig", () => {
  test("treats empty OPENAI_API_KEY as unset", () => {
    const persisted = PersistedConfigSchema.parse({});
    const env = {
      OPENAI_API_KEY: "",
    } as NodeJS.ProcessEnv;

    const resolved = resolveOpenAiSpeechConfig({
      env,
      persisted,
      providers: {
        dictationStt: { provider: "local", explicit: false },
        voiceStt: { provider: "local", explicit: false },
        voiceTts: { provider: "local", explicit: false },
      },
    });

    expect(resolved).toBeUndefined();
  });

  test("uses trimmed OPENAI_API_KEY when configured", () => {
    const persisted = PersistedConfigSchema.parse({});
    const env = {
      OPENAI_API_KEY: "  sk-test  ",
    } as NodeJS.ProcessEnv;

    const resolved = resolveOpenAiSpeechConfig({
      env,
      persisted,
      providers: {
        dictationStt: { provider: "openai", explicit: true },
        voiceStt: { provider: "openai", explicit: true },
        voiceTts: { provider: "openai", explicit: true },
      },
    });

    expect(resolved?.apiKey).toBe("sk-test");
    expect(resolved?.stt?.apiKey).toBe("sk-test");
    expect(resolved?.tts?.apiKey).toBe("sk-test");
  });
});
