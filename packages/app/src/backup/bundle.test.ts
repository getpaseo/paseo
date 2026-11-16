import { describe, expect, it } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import type { HostConnection, HostProfile } from "@/types/host-connection";
import {
  BackupFileError,
  exportHostProfile,
  parseBackup,
  serializeBackup,
  type Backup,
} from "./bundle";

const relay: HostConnection = {
  id: "relay:wss:relay.example.test:443",
  type: "relay",
  relayEndpoint: "relay.example.test:443",
  useTls: true,
  daemonPublicKeyB64: "AAAA",
};
const lan: HostConnection = {
  id: "direct:10.0.0.5:6767",
  type: "directTcp",
  endpoint: "10.0.0.5:6767",
};
const loopback: HostConnection = {
  id: "direct:localhost:6767",
  type: "directTcp",
  endpoint: "localhost:6767",
};
const socket: HostConnection = {
  id: "socket:/tmp/p.sock",
  type: "directSocket",
  path: "/tmp/p.sock",
};
const routed: HostConnection = { id: "routed:srv_a", type: "routed", originServerId: "srv_a" };

function host(connections: HostConnection[], password?: string): HostProfile {
  return {
    serverId: "srv_work",
    ...(password ? { password } : {}),
    label: "Work",
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections,
    preferredConnectionId: connections[0]?.id ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function backup(overrides: Partial<Backup> = {}): Backup {
  return {
    format: "paseo-backup",
    version: 1,
    createdAt: "2026-10-28T00:00:00.000Z",
    appVersion: "0.14.0",
    device: {},
    hosts: [],
    ...overrides,
  };
}

describe("exportHostProfile", () => {
  it("drops the password and every connection that only works on this device", () => {
    const exported = exportHostProfile(host([loopback, socket, routed, relay, lan], "secret"));

    expect(exported).toEqual({
      serverId: "srv_work",
      label: "Work",
      appearance: defaultHostAppearance(),
      lifecycle: {},
      connections: [relay, lan],
      preferredConnectionId: relay.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      passwordRequired: true,
    });
    expect(JSON.stringify(exported)).not.toContain("secret");
  });

  it("leaves out a host that has no portable connection", () => {
    expect(exportHostProfile(host([loopback, socket]))).toBeNull();
  });
});

describe("parseBackup", () => {
  it("reads back what export wrote", () => {
    const exported = exportHostProfile(host([relay], "secret"));
    const parsed = parseBackup(
      serializeBackup(
        backup({
          device: {
            shortcutOverrides: { "new-workspace": "Mod+2" },
            hosts: exported ? [exported] : [],
          },
        }),
      ),
    );

    expect(parsed.device.shortcutOverrides).toEqual({ "new-workspace": "Mod+2" });
    expect(parsed.device.hosts).toEqual([
      { profile: expect.objectContaining({ serverId: "srv_work" }), passwordRequired: true },
    ]);
    expect(parsed.unreadable).toEqual([]);
  });

  it("never imports a password, even when a file carries one", () => {
    const parsed = parseBackup(
      JSON.stringify(
        backup({ device: { hosts: [{ ...host([relay]), password: "planted" }] as never } }),
      ),
    );

    expect(parsed.device.hosts?.[0]?.profile).not.toHaveProperty("password");
  });

  it("marks sections it cannot read instead of applying them", () => {
    const parsed = parseBackup(
      JSON.stringify(
        backup({
          device: { changesPreferences: { layout: "diagonal" } as never },
          hosts: [{ serverId: "srv_b", label: "B", document: { format: "other" } as never }],
        }),
      ),
    );

    expect(parsed.device.changesPreferences).toBeUndefined();
    expect(parsed.hosts).toEqual([]);
    expect(parsed.unreadable).toEqual(["changesPreferences", "host:srv_b"]);
  });

  it.each([
    ["not json", "This file is not a Paseo backup: it is not JSON."],
    [
      JSON.stringify({ format: "paseo-host-config", version: 1 }),
      'This file is not a Paseo backup (format "paseo-backup").',
    ],
    [
      JSON.stringify({ ...backup(), version: 2 }),
      "This backup was made by a newer version of Paseo (format version 2). Update Paseo to import it.",
    ],
  ])("refuses %s", (text, message) => {
    expect(() => parseBackup(text)).toThrow(new BackupFileError(message));
  });
});
