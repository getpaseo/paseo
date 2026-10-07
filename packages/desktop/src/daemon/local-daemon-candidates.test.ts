import { describe, expect, it } from "vitest";
import { localDaemonCandidates } from "./local-daemon-candidates";

describe("local daemon discovery candidates", () => {
  it("respects the configured port or non-TCP transport during startup", () => {
    expect(localDaemonCandidates(["127.0.0.1:7777"], false)).toEqual([
      { host: "127.0.0.1", port: 7777 },
    ]);
    expect(localDaemonCandidates(["/tmp/paseo.sock"], false)).toEqual([]);
    expect(localDaemonCandidates(["127.0.0.1:0"], false)).toEqual([]);
  });
  it("includes configured local ports, normalizes wildcard binds and deduplicates", () => {
    expect(localDaemonCandidates(["localhost:8080", "0.0.0.0:8080", "[::]:9090", "80"])).toEqual([
      { host: "127.0.0.1", port: 8080 },
      { host: "[::1]", port: 9090 },
      { host: "127.0.0.1", port: 80 },
      { host: "127.0.0.1", port: 6767 },
      { host: "[::1]", port: 6767 },
    ]);
  });

  it("does not probe remote addresses, socket paths or invalid ports", () => {
    expect(
      localDaemonCandidates([
        "example.com:6767",
        "192.168.1.1:6767",
        "/tmp/paseo.sock",
        "pipe://paseo",
        "127.0.0.1:0",
        "127.0.0.1:65536",
        null,
      ]),
    ).toEqual(localDaemonCandidates([]));
  });
});
