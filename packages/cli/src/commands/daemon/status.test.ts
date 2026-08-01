import { describe, expect, test } from "vitest";
import { formatProviderBinaryStatus, selectRelayStatus } from "./status.js";

describe("daemon provider-health status formatting", () => {
  test("keeps checking and stale distinct from unavailable", () => {
    expect(
      formatProviderBinaryStatus({
        label: "OpenCode",
        path: "available",
        version: null,
        source: "daemon",
        healthStatus: "checking",
      }),
    ).toBe("checking (daemon)");
    expect(
      formatProviderBinaryStatus({
        label: "OpenCode",
        path: "available",
        version: null,
        source: "daemon",
        healthStatus: "stale",
      }),
    ).toBe("available (stale, daemon)");
    expect(
      formatProviderBinaryStatus({
        label: "OpenCode",
        path: null,
        version: "last probe failed",
        source: "daemon",
        healthStatus: "stale",
      }),
    ).toBe("unavailable (stale, daemon): last probe failed");
    expect(
      formatProviderBinaryStatus({
        label: "OpenCode",
        path: null,
        version: "provider exploded",
        source: "daemon",
        healthStatus: "unavailable",
      }),
    ).toBe("unavailable (daemon): provider exploded");
  });

  test("classifies mixed-version daemon payloads from the legacy availability boolean", () => {
    expect(
      formatProviderBinaryStatus({
        label: "OpenCode",
        path: "available",
        version: null,
        source: "daemon",
      }),
    ).toBe("available (daemon)");
    expect(
      formatProviderBinaryStatus({
        label: "OpenCode",
        path: null,
        version: "not installed",
        source: "daemon",
      }),
    ).toBe("not found (daemon)");
  });
});

describe("selectRelayStatus", () => {
  const persisted = {
    enabled: false,
    endpoint: "persisted.internal:443",
    publicEndpoint: "persisted.example.com:443",
    useTls: true,
    publicUseTls: true,
  };

  test("uses the running daemon relay state over persisted config", () => {
    expect(
      selectRelayStatus({
        persisted,
        live: {
          enabled: true,
          endpoint: "live.internal:443",
          publicEndpoint: "live.example.com:443",
          useTls: true,
          publicUseTls: true,
        },
      }),
    ).toBe("wss://live.example.com:443");
  });

  test("falls back to persisted config when the daemon cannot report live state", () => {
    expect(selectRelayStatus({ persisted })).toBe("disabled");
  });
});
