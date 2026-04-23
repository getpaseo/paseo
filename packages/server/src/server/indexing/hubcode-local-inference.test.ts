import { describe, it, expect } from "vitest";
import pino from "pino";

import {
  DEFAULT_HUBCODE_LOCAL_MODEL,
  createHubcodeLocalInference,
} from "./hubcode-local-inference.js";

describe("createHubcodeLocalInference", () => {
  it("forwards inputs to the pipeline and reports the default model + dimension", async () => {
    let pipelineCalls = 0;
    const fakeFn = async (text: string | string[]): Promise<number[][]> => {
      const inputs = Array.isArray(text) ? text : [text];
      return inputs.map(() => [0.1, 0.2, 0.3, 0.4]);
    };
    const infer = createHubcodeLocalInference({
      logger: pino({ enabled: false }),
      pipelineFactory: async () => {
        pipelineCalls += 1;
        return fakeFn;
      },
    });
    const result = await infer(["hello", "world"], { model: undefined });
    expect(pipelineCalls).toBe(1);
    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(result.dimension).toBe(4);
    expect(result.model).toBe(DEFAULT_HUBCODE_LOCAL_MODEL);
  });

  it("respects a custom model id and prefers caller-provided model in result", async () => {
    const infer = createHubcodeLocalInference({
      logger: pino({ enabled: false }),
      modelId: "Xenova/bge-base-en-v1.5",
      pipelineFactory: async () => async () => [[1, 2, 3]],
    });
    const result = await infer(["x"], { model: "client-supplied" });
    expect(result.model).toBe("client-supplied");
  });

  it("loads the pipeline lazily and caches across calls", async () => {
    let factoryCalls = 0;
    const infer = createHubcodeLocalInference({
      logger: pino({ enabled: false }),
      pipelineFactory: async () => {
        factoryCalls += 1;
        return async (text) => {
          const inputs = Array.isArray(text) ? text : [text];
          return inputs.map(() => [0.5]);
        };
      },
    });
    expect(factoryCalls).toBe(0);
    await infer(["a"]);
    await infer(["b"]);
    await infer(["c"]);
    expect(factoryCalls).toBe(1);
  });

  it("warns (returns native dim) when caller requests an unsupported reduction", async () => {
    const infer = createHubcodeLocalInference({
      logger: pino({ enabled: false }),
      pipelineFactory: async () => async () => [[1, 2, 3, 4]],
    });
    const result = await infer(["x"], { dimensions: 256 });
    expect(result.dimension).toBe(4);
  });

  it("propagates pipeline failures", async () => {
    const infer = createHubcodeLocalInference({
      logger: pino({ enabled: false }),
      pipelineFactory: async () => async () => {
        throw new Error("model load failed");
      },
    });
    await expect(infer(["x"])).rejects.toThrow(/model load failed/);
  });
});
