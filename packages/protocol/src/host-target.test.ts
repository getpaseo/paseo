import { expect, test } from "vitest";
import { buildEtTunnelArgs, parseEtTransportUri } from "./et-transport.js";
import { parseHostTarget } from "./host-target.js";

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
test("ET separates its three ports and daemon credentials", () => {
  expect(
    parseHostTarget(
      "et://deploy@build-box:2023?sshPort=2222&daemonPort=7777&password=%20secret%20",
    ),
  ).toEqual({
    kind: "et",
    et: { host: "deploy@build-box", etPort: 2023, sshPort: 2222, daemonPort: 7777 },
    password: " secret ",
    description: "et://build-box:2023 (daemon port 7777)",
  });
});
test("ET accepts aliases and canonicalizes IPv6 targets with default ports", () => {
  expect(parseHostTarget("et://Build_box")).toEqual({
    kind: "et",
    et: { host: "Build_box", etPort: 2022, daemonPort: 6767 },
    description: "et://Build_box:2022 (daemon port 6767)",
  });
  expect(parseHostTarget("et://[2001:0db8::1]/")).toEqual({
    kind: "et",
    et: { host: "2001:db8::1", etPort: 2022, daemonPort: 6767 },
    description: "et://[2001:db8::1]:2022 (daemon port 6767)",
  });
});
test.each([
  "et://",
  "et://-host",
  "et://user@-host",
  "et://-user@host",
  "et://user%40other@host",
  "et://user%24value@host",
  "et://user:SECRET@host",
  "et://user:@host",
  "et://host:",
  "et://host:0",
  "et://host:65536",
  "et://host?sshPort=65536",
  "et://host?sshPort=22&sshPort=22",
  "et://host?daemonPort=0",
  "et://host?daemonPort=0x1a6f",
  "et://host?daemonPort=6767&daemonPort=6767",
  "et://host?password=SECRET&password=SECRET",
  "et://host?unknown=SECRET",
  "et://host#",
  "et://host#SECRET",
  "et://ho\tst",
  "et://host/path",
  "et://host/path/../",
])("rejects malformed ET target %j", (connection) => {
  expect(() => parseHostTarget(connection)).toThrow(/^Invalid host connection\./);
});
test("ET launches a single stdio forward with separate SSH bootstrap settings", () => {
  expect(
    buildEtTunnelArgs(
      parseEtTransportUri("et://deploy@[2001:db8::1]:2023?sshPort=2222&daemonPort=7777"),
    ),
  ).toEqual([
    "--no-persist",
    "--disconnect-timeout",
    "1",
    "--port",
    "2023",
    "-N",
    "-o",
    "BatchMode=yes",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "--ssh-option",
    "ConnectTimeout=10",
    "--ssh-option",
    "ClearAllForwardings=yes",
    "--ssh-option",
    "ForwardAgent=no",
    "--ssh-option",
    "ControlPath=none",
    "--ssh-option",
    "RemoteCommand=none",
    "-p",
    "2222",
    "-W",
    "127.0.0.1:7777",
    "deploy@2001:db8::1",
  ]);
  expect(buildEtTunnelArgs(parseEtTransportUri("et://alias"))).not.toContain("-p");
});
test.each(["-option", "u@-option", "u@host:22", "u@one@host", "u`id`@host"])(
  "ET rejects an unsafe subprocess destination %j",
  (host) => {
    expect(() => buildEtTunnelArgs({ host, etPort: 2022, daemonPort: 6767 })).toThrow();
  },
);
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
