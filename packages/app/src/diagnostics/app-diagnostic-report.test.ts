import { describe, expect, test } from "vitest";
import { formatHostRuntimeSection, redactAppDiagnosticReport } from "./app-diagnostic-report";
import type { HostRuntimeSnapshot } from "@/runtime/host-runtime";
import type { HostProfile } from "@/types/host-connection";

function makeHost(): HostProfile {
  return {
    serverId: "srv-secret",
    label: "Secret host",
    lifecycle: {},
    preferredConnectionId: "direct:secret.example.test:6767",
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
    connections: [
      {
        id: "direct:secret.example.test:6767",
        type: "directTcp",
        endpoint: "secret.example.test:6767",
        useTls: true,
        password: "tcp-password",
      },
      {
        id: "relay:relay.secret.test:443",
        type: "relay",
        relayEndpoint: "relay.secret.test:443",
        useTls: true,
        daemonPublicKeyB64: "daemon-public-key-secret",
      },
      {
        id: "socket:/tmp/paseo-secret.sock",
        type: "directSocket",
        path: "/tmp/paseo-secret.sock",
      },
      {
        id: "pipe:\\\\.\\pipe\\paseo-secret",
        type: "directPipe",
        path: "\\\\.\\pipe\\paseo-secret",
      },
    ],
  };
}

describe("app diagnostics report", () => {
  test("formats connection rows without raw connection details", () => {
    const host = makeHost();
    const snapshot: HostRuntimeSnapshot = {
      serverId: host.serverId,
      activeConnectionId: "relay:relay.secret.test:443",
      activeConnection: {
        type: "relay",
        endpoint: "relay.secret.test:443",
        display: "relay",
      },
      connectionStatus: "online",
      client: null,
      lastError: null,
      lastOnlineAt: "2026-06-25T00:00:00.000Z",
      agentDirectoryStatus: "ready",
      agentDirectoryError: null,
      hasEverLoadedAgentDirectory: true,
      probeByConnectionId: new Map([
        ["direct:secret.example.test:6767", { status: "available", latencyMs: 42 }],
        ["relay:relay.secret.test:443", { status: "available", latencyMs: 8 }],
      ]),
      clientGeneration: 1,
    };

    const report = formatHostRuntimeSection({ host, snapshot });

    expect(report).toContain("direct TCP");
    expect(report).toContain("relay");
    expect(report).toContain("local socket");
    expect(report).toContain("local pipe");
    expect(report).not.toContain("secret.example.test");
    expect(report).not.toContain("relay.secret.test");
    expect(report).not.toContain("daemon-public-key-secret");
    expect(report).not.toContain("/tmp/paseo-secret.sock");
    expect(report).not.toContain("tcp-password");
  });

  test("redacts saved connection secrets from collected daemon and desktop text", () => {
    const host = makeHost();
    const redacted = redactAppDiagnosticReport(
      [
        "secret.example.test:6767",
        "relay.secret.test:443",
        "daemon-public-key-secret",
        "/tmp/paseo-secret.sock",
        "\\\\.\\pipe\\paseo-secret",
        "password=tcp-password",
        "paseo://pairing-secret",
      ].join("\n"),
      [host],
    );

    expect(redacted).not.toContain("secret.example.test");
    expect(redacted).not.toContain("relay.secret.test");
    expect(redacted).not.toContain("daemon-public-key-secret");
    expect(redacted).not.toContain("/tmp/paseo-secret.sock");
    expect(redacted).not.toContain("\\\\.\\pipe\\paseo-secret");
    expect(redacted).not.toContain("tcp-password");
    expect(redacted).not.toContain("pairing-secret");
  });
});
