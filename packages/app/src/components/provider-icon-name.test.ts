import { describe, expect, it } from "vitest";
import { resolveProviderIconName } from "./provider-icon-name";

describe("resolveProviderIconName", () => {
  it("returns the built-in identifier for known provider ids", () => {
    expect(resolveProviderIconName("kiro")).toEqual({ kind: "builtin", id: "kiro" });
    expect(resolveProviderIconName("claude")).toEqual({ kind: "builtin", id: "claude" });
    expect(resolveProviderIconName("omp")).toEqual({ kind: "builtin", id: "omp" });
  });

  it("returns the catalog identifier for ACP catalog provider ids that ship an icon", () => {
    expect(resolveProviderIconName("amp-acp")).toEqual({ kind: "catalog", id: "amp-acp" });
  });

  it("falls back to the bot icon for unknown custom providers", () => {
    expect(resolveProviderIconName("custom-claude-profile")).toEqual({ kind: "bot" });
  });
});
