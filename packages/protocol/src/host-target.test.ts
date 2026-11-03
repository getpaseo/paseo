import { expect, test } from "vitest";
import { parseHostTarget } from "./host-target.js";
import { serializeSshTransportUri } from "./ssh-transport.js";
import { serializeSocketHostTarget } from "./host-target.js";
import {
  parseConnectionUri,
  serializeConnectionUri,
  serializeRelayConnectionUri,
} from "./daemon-endpoints.js";

test("SSH and local socket targets round trip through their serializers", () => {
  const ssh = parseHostTarget("ssh://deploy@build-box:2222?daemonPort=7777");
  if (ssh.kind !== "ssh") throw new Error("expected SSH");
  expect(parseHostTarget(serializeSshTransportUri(ssh.ssh))).toEqual(ssh);
  for (const [type, path] of [
    ["unix", "/tmp/paseo.sock"],
    ["pipe", "\\\\.\\pipe\\paseo"],
  ] as const) {
    const target = parseHostTarget(`${type}://${path}`);
    expect(parseHostTarget(serializeSocketHostTarget(type, path))).toEqual(target);
  }
});

test("TCP and relay targets round trip through credential-free serializers", () => {
  const tcp = parseConnectionUri("tcp://example.com:6767?ssl=true&password=secret");
  const tcpUri = serializeConnectionUri(tcp);
  expect(tcpUri).not.toContain("secret");
  expect(parseHostTarget(tcpUri)).toMatchObject({
    connection: { type: "directTcp", endpoint: "example.com:6767", useTls: true },
  });
  const relay = parseHostTarget(
    "relay://relay.example:443/server?key=public&ssl=true&password=secret",
  );
  if (relay.kind !== "socket" || relay.connection.type !== "relay")
    throw new Error("expected relay");
  const relayUri = serializeRelayConnectionUri({ offer: relay.connection.offer });
  expect(relayUri).not.toContain("secret");
  expect(parseHostTarget(relayUri)).toMatchObject({ connection: relay.connection });
});

test.each([
  ["example.com:6767", { type: "directTcp", endpoint: "example.com:6767", useTls: false }],
  [
    "tcp://example.com:6767?ssl=true",
    { type: "directTcp", endpoint: "example.com:6767", useTls: true },
  ],
  ["wss://example.com/ws", { type: "directTcp", endpoint: "example.com:443", useTls: true }],
  ["unix:///tmp/paseo.sock", { type: "directSocket", path: "/tmp/paseo.sock" }],
  ["pipe://mypipe", { type: "directPipe", path: "mypipe" }],
])("%s exposes its structured connection", (input, connection) => {
  expect(parseHostTarget(input)).toMatchObject({ kind: "socket", connection });
});

test.each([
  ["127.0.0.1:6767", "tcp://127.0.0.1:6767"],
  ["4321", "tcp://127.0.0.1:4321"],
  ["[::1]:4321", "tcp://[::1]:4321"],
  ["unix:///tmp/paseo.sock", "unix:///tmp/paseo.sock"],
  ["pipe://\\\\.\\pipe\\paseo", "pipe://\\\\.\\pipe\\paseo"],
  ["wss://example.com/custom?token=secret", "wss://example.com"],
  ["tcp://example.com:6767?password=secret", "tcp://example.com:6767"],
])(
  "the shared connector accepts %s and exposes only safe display text",
  (connection, description) => {
    expect(parseHostTarget(connection).description).toBe(description);
  },
);
test("SSH daemon credentials are separate from SSH authentication and excluded from display text", () => {
  expect(parseHostTarget("ssh://deploy@build-box:2222?daemonPort=7777&password=secret")).toEqual({
    kind: "ssh",
    ssh: { host: "deploy@build-box", sshPort: 2222, daemonPort: 7777 },
    password: "secret",
    description: "ssh://build-box:2222 (daemon port 7777)",
  });
});
test.each([
  "",
  "ssh://-bad",
  "ssh://user:secret@host",
  "ssh://host?unknown=secret",
  "unix://",
  "tcp://host:0",
  "C:\\Users\\socket",
  "alice:example-secret@localhost:6767",
  "not-a-scheme://localhost:6767",
  "localhost/path:6767",
  "localhost?password=example-secret:6767",
  "localhost#example-secret:6767",
  "tcp://localhost/path:6767",
  "relay://alice:example-secret@localhost:6767/server?key=private",
])("invalid target syntax is rejected without echoing %s", (connection) => {
  expect(() => parseHostTarget(connection)).toThrow("Invalid host connection");
});

test("SSH aliases and DNS names retain their connection semantics", () => {
  expect(parseHostTarget("build-box.example.:6767").description).toBe(
    "tcp://build-box.example.:6767",
  );
  expect(parseHostTarget("ssh://deploy@my_ssh-alias")).toMatchObject({
    kind: "ssh",
    ssh: { host: "deploy@my_ssh-alias" },
  });
});

test("encoded SSH usernames cannot leak into the target description", () => {
  expect(parseHostTarget("ssh://alice%3Aexample-secret@my-alias").description).toBe(
    "ssh://my-alias (daemon port 6767)",
  );
});

test("pairing offers cannot publish a credential-bearing or malformed relay authority", () => {
  for (const endpoint of [
    "alice:example-secret@localhost:6767",
    "localhost/path:6767",
    "localhost?token=example-secret:6767",
  ]) {
    const offer = {
      v: 2,
      serverId: "srv_test",
      daemonPublicKeyB64: "private-key",
      relay: { endpoint, useTls: false },
    };
    const url = `https://app.paseo.sh/#offer=${Buffer.from(JSON.stringify(offer)).toString("base64url")}`;
    expect(() => parseHostTarget(url)).toThrow("Invalid host connection");
  }
});
