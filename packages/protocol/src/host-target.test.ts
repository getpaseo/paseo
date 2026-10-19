import { expect, test } from "vitest";
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
    description: "ssh://deploy@build-box:2222 (daemon port 7777)",
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
])("invalid target syntax is rejected without echoing %s", (connection) => {
  expect(() => parseHostTarget(connection)).toThrow("Invalid host connection");
});
