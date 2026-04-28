import { describe, it, expect } from "vitest";
import { buildLoopRunInput } from "./run.js";
import type { LoopRunOptions } from "./types.js";

describe("buildLoopRunInput", () => {
  it("should parse provider/model from provider string", () => {
    const options: LoopRunOptions = {
      provider: "opencode/hy3-preview-free",
      model: undefined,
      verifyProvider: undefined,
      verifyModel: undefined,
      verify: undefined,
      verifyCheck: [],
      archive: false,
      name: undefined,
      sleep: undefined,
      maxIterations: undefined,
      maxTime: undefined,
    } as LoopRunOptions;

    const result = buildLoopRunInput("test prompt", options);

    expect(result.provider).toBe("opencode");
    expect(result.model).toBe("hy3-preview-free");
  });

  it("should use provider only when no model in string", () => {
    const options = {
      provider: "opencode",
      model: undefined,
      verifyProvider: undefined,
      verifyModel: undefined,
      verify: undefined,
      verifyCheck: [],
      archive: false,
      name: undefined,
      sleep: undefined,
      maxIterations: undefined,
      maxTime: undefined,
    } as LoopRunOptions;

    const result = buildLoopRunInput("test prompt", options);

    expect(result.provider).toBe("opencode");
    expect(result.model).toBeUndefined();
  });

  it("should pass verifierProvider with model parsing", () => {
    const options = {
      provider: undefined,
      model: undefined,
      verifyProvider: "codex/gpt-5.4",
      verifyModel: undefined,
      verify: undefined,
      verifyCheck: [],
      archive: false,
      name: undefined,
      sleep: undefined,
      maxIterations: undefined,
      maxTime: undefined,
    } as LoopRunOptions;

    const result = buildLoopRunInput("test prompt", options);

    expect(result.verifierProvider).toBe("codex");
    expect(result.verifierModel).toBe("gpt-5.4");
  });

  it("should prefer explicit model over parsed model", () => {
    const options = {
      provider: "opencode/hy3-preview-free",
      model: "other-model",
      verifyProvider: undefined,
      verifyModel: undefined,
      verify: undefined,
      verifyCheck: [],
      archive: false,
      name: undefined,
      sleep: undefined,
      maxIterations: undefined,
      maxTime: undefined,
    } as LoopRunOptions;

    const result = buildLoopRunInput("test prompt", options);

    expect(result.provider).toBe("opencode");
    expect(result.model).toBe("other-model");
  });
});
