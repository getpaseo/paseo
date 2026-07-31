import { describe, expect, test } from "vitest";

import { formatProviderBinaryStatus } from "./status.js";

describe("daemon provider-health status formatting", () => {
  test("keeps checking and stale distinct from unavailable", () => {
    expect(
      formatProviderBinaryStatus({
        label: "Codex",
        path: null,
        version: null,
        source: "daemon",
        healthStatus: "checking",
      }),
    ).toBe("checking (daemon)");
    expect(
      formatProviderBinaryStatus({
        label: "Codex",
        path: "available",
        version: null,
        source: "daemon",
        healthStatus: "stale",
      }),
    ).toBe("available (stale, daemon)");
    expect(
      formatProviderBinaryStatus({
        label: "Codex",
        path: null,
        version: "last probe failed",
        source: "daemon",
        healthStatus: "stale",
      }),
    ).toBe("unavailable (stale, daemon): last probe failed");
    expect(
      formatProviderBinaryStatus({
        label: "Codex",
        path: null,
        version: "provider exploded",
        source: "daemon",
        healthStatus: "unavailable",
      }),
    ).toBe("unavailable (daemon): provider exploded");
  });
});
