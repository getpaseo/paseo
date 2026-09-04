import { describe, expect, test } from "vitest";
import { resolveForkFidelity } from "./fork-preferences-store";

describe("resolveForkFidelity", () => {
  test("keeps a native preference when the provider can branch", () => {
    expect(resolveForkFidelity({ preferred: "native", canForkNatively: true })).toBe("native");
  });

  // The menu draws its check on the resolved value, so a stored preference the
  // provider cannot honour must read as summary rather than promising history
  // the fork will not carry.
  test("falls back to summary when the provider cannot branch", () => {
    expect(resolveForkFidelity({ preferred: "native", canForkNatively: false })).toBe("summary");
  });

  test("never upgrades an explicit summary preference", () => {
    expect(resolveForkFidelity({ preferred: "summary", canForkNatively: true })).toBe("summary");
  });
});
