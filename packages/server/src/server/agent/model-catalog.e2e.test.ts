import { describe, expect, test } from "vitest";

import {
  fetchClaudeModelCatalog,
  fetchCodexModelCatalog,
} from "./model-catalog.js";

describe("provider model catalogs", () => {
  test(
    "Claude catalog exposes Sonnet and Haiku variants",
    async () => {
      const models = await fetchClaudeModelCatalog();
      expect(models.length).toBeGreaterThan(0);

      const descriptions = models
        .map((model) => `${model.label} ${model.description ?? ""}`.toLowerCase());
      expect(descriptions.some((text) => text.includes("sonnet 4.5"))).toBe(true);
      expect(descriptions.some((text) => text.includes("haiku"))).toBe(true);
    },
    180_000
  );

  test(
    "Codex catalog exposes gpt-5.1-codex",
    async () => {
      const models = await fetchCodexModelCatalog();
      const ids = models.map((model) => model.id);
      expect(ids).toContain("gpt-5.1-codex");
    },
    180_000
  );
});
