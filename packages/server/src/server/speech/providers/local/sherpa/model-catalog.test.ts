import { describe, expect, test } from "vitest";

import {
  resolveDefaultSttModelForLanguage,
  resolveDefaultTtsModelForLanguage,
} from "./model-catalog.js";

describe("local speech language defaults", () => {
  test.each(["zh", "zh-CN", "ZH-Hant"])("selects SenseVoice for %s STT", (language) => {
    expect(resolveDefaultSttModelForLanguage(language)).toBe("sense-voice-zh-en-ja-ko-yue-int8");
  });

  test("selects multilingual Parakeet for a regional Portuguese tag", () => {
    expect(resolveDefaultSttModelForLanguage("pt-BR")).toBe("parakeet-tdt-0.6b-v3-int8");
  });

  test.each(["zh", "zh-CN", "ZH-Hant"])("selects multilingual Kokoro for %s TTS", (language) => {
    expect(resolveDefaultTtsModelForLanguage(language)).toBe("kokoro-multi-lang-v1_0");
  });

  test("preserves the English defaults", () => {
    expect(resolveDefaultSttModelForLanguage("en-US")).toBe("parakeet-tdt-0.6b-v2-int8");
    expect(resolveDefaultTtsModelForLanguage("en-US")).toBe("kokoro-en-v0_19");
  });
});
