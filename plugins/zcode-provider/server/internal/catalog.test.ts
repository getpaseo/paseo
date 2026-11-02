import { describe, expect, test } from "vitest";
import { mapCatalog } from "./catalog.js";

describe("ZCode catalog mapping", () => {
  test("maps models, modes and thought levels from the session settings", () => {
    const catalog = mapCatalog({
      settings: {
        model: {
          current: { providerId: "zai", modelId: "glm-5" },
          available: [
            { ref: { providerId: "zai", modelId: "glm-5" }, label: "GLM 5" },
            { ref: { providerId: "zai", modelId: "glm-4" }, label: "GLM 4" },
          ],
        },
        mode: { current: "plan" },
        thoughtLevel: {
          enabled: true,
          current: "high",
          available: [{ value: "high", label: "High" }],
        },
      },
    });

    expect(catalog.models.map((model) => model.id)).toEqual(["zai/glm-5", "zai/glm-4"]);
    expect(catalog.modes.map((mode) => mode.id)).toEqual(["build", "guarded", "plan", "yolo"]);
    expect(catalog.thinkingOptions?.map((option) => option.id)).toEqual(["high"]);
    expect(catalog.defaultModel).toBe("zai/glm-5");
    expect(catalog.defaultMode).toBe("plan");
    expect(catalog.defaultThinkingOption).toBe("high");
  });

  test("offers no thought levels when ZCode disabled them", () => {
    const catalog = mapCatalog({
      settings: {
        thoughtLevel: { enabled: false, available: [{ value: "high", label: "High" }] },
      },
    });

    expect(catalog.thinkingOptions).toEqual([]);
  });

  test("returns an empty catalog for a snapshot without settings", () => {
    const catalog = mapCatalog({});

    expect(catalog.models).toEqual([]);
    expect(catalog.modes).toHaveLength(4);
    expect(catalog.defaultModel).toBeUndefined();
  });
});
