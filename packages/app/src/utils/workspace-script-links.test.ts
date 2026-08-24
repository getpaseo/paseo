import { describe, expect, it } from "vitest";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import type { ActiveConnection } from "@/runtime/host-runtime";
import { resolveWorkspaceScriptLink } from "./workspace-script-links";

const runningService: WorkspaceScriptPayload = {
  scriptName: "web",
  type: "service",
  hostname: "web--feature--paseo.localhost",
  port: 3000,
  localProxyUrl: "http://web--feature--paseo.localhost:6767",
  publicProxyUrl: null,
  proxyUrl: "http://web--feature--paseo.localhost:6767",
  lifecycle: "running",
  health: "healthy",
  exitCode: null,
  terminalId: null,
};

function resolveLink(
  activeConnection: ActiveConnection | null,
  script: WorkspaceScriptPayload = runningService,
) {
  return resolveWorkspaceScriptLink({ script, activeConnection });
}

describe("resolveWorkspaceScriptLink", () => {
  it("defaults to the memorable Paseo URL locally and keeps direct as a fallback", () => {
    expect(
      resolveLink({ type: "directTcp", endpoint: "localhost:6767", display: "localhost:6767" }),
    ).toEqual({
      primary: {
        kind: "paseo",
        label: "web--feature--paseo.localhost:6767",
        url: "http://web--feature--paseo.localhost:6767",
      },
      targets: [
        {
          kind: "paseo",
          label: "web--feature--paseo.localhost:6767",
          url: "http://web--feature--paseo.localhost:6767",
        },
        { kind: "direct", label: "localhost:3000", url: "http://localhost:3000" },
      ],
    });
  });

  it("defaults to an explicitly configured reverse proxy", () => {
    const publicUrl = "https://web--feature--paseo.services.example.com";
    expect(
      resolveLink(
        { type: "directSocket", endpoint: "/tmp/paseo.sock", display: "socket" },
        { ...runningService, publicProxyUrl: publicUrl, proxyUrl: publicUrl },
      ),
    ).toEqual({
      primary: {
        kind: "public",
        label: "web--feature--paseo.services.example.com",
        url: publicUrl,
      },
      targets: [
        {
          kind: "public",
          label: "web--feature--paseo.services.example.com",
          url: publicUrl,
        },
        {
          kind: "paseo",
          label: "web--feature--paseo.localhost:6767",
          url: "http://web--feature--paseo.localhost:6767",
        },
        { kind: "direct", label: "localhost:3000", url: "http://localhost:3000" },
      ],
    });
  });

  it("uses the daemon host and service port over a direct network connection", () => {
    expect(
      resolveLink({
        type: "directTcp",
        endpoint: "mac-mini.tail123.ts.net:6767",
        display: "mac-mini.tail123.ts.net:6767",
      }),
    ).toEqual({
      primary: {
        kind: "paseo",
        label: "web--feature--paseo.localhost:6767",
        url: "http://web--feature--paseo.localhost:6767",
      },
      targets: [
        {
          kind: "paseo",
          label: "web--feature--paseo.localhost:6767",
          url: "http://web--feature--paseo.localhost:6767",
        },
        {
          kind: "direct",
          label: "mac-mini.tail123.ts.net:3000",
          url: "http://mac-mini.tail123.ts.net:3000",
        },
      ],
    });
  });

  it("offers the reverse proxy and direct route over a direct network connection", () => {
    const publicUrl = "https://web--feature--paseo.services.example.com";
    expect(
      resolveLink(
        { type: "directTcp", endpoint: "mac-mini.tail123.ts.net:6767", display: "remote" },
        { ...runningService, publicProxyUrl: publicUrl, proxyUrl: publicUrl },
      ).targets,
    ).toEqual([
      { kind: "public", label: "web--feature--paseo.services.example.com", url: publicUrl },
      {
        kind: "paseo",
        label: "web--feature--paseo.localhost:6767",
        url: "http://web--feature--paseo.localhost:6767",
      },
      {
        kind: "direct",
        label: "mac-mini.tail123.ts.net:3000",
        url: "http://mac-mini.tail123.ts.net:3000",
      },
    ]);
  });

  it("keeps service routes available independently of a relay connection", () => {
    const relay: ActiveConnection = {
      type: "relay",
      endpoint: "relay.paseo.sh:443",
      display: "relay",
    };
    expect(resolveLink(relay)).toEqual({
      primary: {
        kind: "paseo",
        label: "web--feature--paseo.localhost:6767",
        url: "http://web--feature--paseo.localhost:6767",
      },
      targets: [
        {
          kind: "paseo",
          label: "web--feature--paseo.localhost:6767",
          url: "http://web--feature--paseo.localhost:6767",
        },
        { kind: "direct", label: "localhost:3000", url: "http://localhost:3000" },
      ],
    });

    const publicUrl = "https://web--feature--paseo.services.example.com";
    expect(
      resolveLink(relay, { ...runningService, publicProxyUrl: publicUrl, proxyUrl: publicUrl }),
    ).toEqual({
      primary: {
        kind: "public",
        label: "web--feature--paseo.services.example.com",
        url: publicUrl,
      },
      targets: [
        {
          kind: "public",
          label: "web--feature--paseo.services.example.com",
          url: publicUrl,
        },
        {
          kind: "paseo",
          label: "web--feature--paseo.localhost:6767",
          url: "http://web--feature--paseo.localhost:6767",
        },
        { kind: "direct", label: "localhost:3000", url: "http://localhost:3000" },
      ],
    });
  });

  it("classifies proxyUrl from older daemons", () => {
    const { localProxyUrl: _local, publicProxyUrl: _public, ...legacyLocal } = runningService;
    expect(resolveLink(null, legacyLocal).targets.map((target) => target.kind)).toEqual([
      "paseo",
      "direct",
    ]);

    const publicUrl = "https://web--feature--paseo.services.example.com";
    expect(
      resolveLink(
        { type: "relay", endpoint: "relay.paseo.sh:443", display: "relay" },
        { ...legacyLocal, proxyUrl: publicUrl },
      ).primary,
    ).toEqual({
      kind: "public",
      label: "web--feature--paseo.services.example.com",
      url: publicUrl,
    });
  });

  it("has no routes for stopped services or plain scripts", () => {
    expect(resolveLink(null, { ...runningService, lifecycle: "stopped" })).toEqual({
      primary: null,
      targets: [],
    });
    expect(resolveLink(null, { ...runningService, type: "script" })).toEqual({
      primary: null,
      targets: [],
    });
  });
});
