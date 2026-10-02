import { describe, expect, it } from "vitest";
import { resolveAndroidOrientationPolicy } from "./policy";

describe("Android orientation policy", () => {
  it("allows a landscape tablet display at the API 35 letterbox baseline", () => {
    expect(resolveAndroidOrientationPolicy({ width: 1280, height: 800 })).toBe("system");
  });

  it("changes with a real fold display transition in either direction", () => {
    const unfolded = { width: 852, height: 883 };
    const folded = { width: 443, height: 994 };
    expect(resolveAndroidOrientationPolicy(unfolded)).toBe("system");
    expect(resolveAndroidOrientationPolicy(folded)).toBe("portrait");
    expect(resolveAndroidOrientationPolicy(unfolded)).toBe("system");
  });

  it("keeps a phone portrait when physically turned landscape", () => {
    expect(resolveAndroidOrientationPolicy({ width: 914, height: 411 })).toBe("portrait");
  });

  it("uses the 600dp shortest-side threshold regardless of rotation", () => {
    expect(resolveAndroidOrientationPolicy({ width: 600, height: 1000 })).toBe("system");
    expect(resolveAndroidOrientationPolicy({ width: 1000, height: 599 })).toBe("portrait");
  });
});
