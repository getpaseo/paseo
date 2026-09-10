import { describe, expect, test } from "vitest";
import { PROVIDER_BINARIES, selectRelayStatus } from "./status.js";

describe("PROVIDER_BINARIES", () => {
  test("includes Pi in the local fallback probe", () => {
    expect(PROVIDER_BINARIES).toContainEqual({ label: "Pi", binary: "pi" });
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
