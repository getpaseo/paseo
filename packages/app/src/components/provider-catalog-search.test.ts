import { describe, expect, it } from "vitest";
import { rankProviderCatalog } from "./provider-catalog-search";

const entries = [
  { id: "kiro-cli", title: "Kiro CLI" },
  { id: "goose", title: "goose" },
  { id: "kimi", title: "Kimi Code CLI" },
  { id: "gemini", title: "Gemini CLI" },
  { id: "qwen-code", title: "Qwen Code" },
  { id: "codex-acp", title: "Codex" },
];

function titles(list: { title: string }[]): string[] {
  return list.map((entry) => entry.title);
}

describe("rankProviderCatalog", () => {
  it("lists every provider alphabetically by name without a query", () => {
    expect(titles(rankProviderCatalog(entries, "  "))).toEqual([
      "Codex",
      "Gemini CLI",
      "goose",
      "Kimi Code CLI",
      "Kiro CLI",
      "Qwen Code",
    ]);
  });

  it("ranks the strongest match first and drops providers that do not match", () => {
    expect(titles(rankProviderCatalog(entries, "cod"))).toEqual([
      "Codex",
      "Kimi Code CLI",
      "Qwen Code",
    ]);
  });

  it("matches in-word subsequences and multiple tokens like the other pickers", () => {
    expect(titles(rankProviderCatalog(entries, "gmni"))).toEqual(["Gemini CLI"]);
    expect(titles(rankProviderCatalog(entries, "qw cod"))).toEqual(["Qwen Code"]);
  });

  it("matches the provider id", () => {
    expect(titles(rankProviderCatalog(entries, "kiro-cli"))).toEqual(["Kiro CLI"]);
  });
});
