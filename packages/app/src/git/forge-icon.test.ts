import { describe, expect, it } from "vitest";
import { GitPullRequest } from "lucide-react-native";
import { getForgeBrandColorMapping, getForgeIconComponent } from "./forge-icon";
import { CLIENT_FORGE_VIEW_MODULES } from "./forges/view";

describe("getForgeIconComponent", () => {
  it("resolves a dedicated brand icon for every registered forge module", () => {
    for (const module of CLIENT_FORGE_VIEW_MODULES) {
      expect(getForgeIconComponent(module.id)).toBe(module.icon);
    }
  });

  it("falls back to the generic pull-request glyph for unknown icon kinds", () => {
    expect(getForgeIconComponent("some-unknown-forge")).toBe(GitPullRequest);
    expect(getForgeIconComponent("")).toBe(GitPullRequest);
  });
});

describe("getForgeBrandColorMapping", () => {
  it("returns a theme mapping only for forges that declare a brand color", () => {
    for (const module of CLIENT_FORGE_VIEW_MODULES) {
      const mapping = getForgeBrandColorMapping(module.id);
      if (module.brandColor) {
        expect(mapping).toBeTypeOf("function");
      } else {
        expect(mapping).toBeNull();
      }
    }
  });

  it("resolves the light or dark brand color from the theme color scheme", () => {
    const branded = CLIENT_FORGE_VIEW_MODULES.find((module) => module.brandColor);
    expect(branded).toBeDefined();
    if (!branded?.brandColor) {
      return;
    }
    const mapping = getForgeBrandColorMapping(branded.id);
    expect(mapping?.({ colorScheme: "light" } as never)).toEqual({
      color: branded.brandColor.light,
    });
    expect(mapping?.({ colorScheme: "dark" } as never)).toEqual({
      color: branded.brandColor.dark,
    });
  });

  it("returns null for unknown icon kinds", () => {
    expect(getForgeBrandColorMapping("some-unknown-forge")).toBeNull();
  });
});
