import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  normalizeDaemonHost,
  resolveDaemonPassword,
  resolveDaemonTarget,
  resolveDefaultDaemonHosts,
} from "./node.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("discovers the configured local socket before TCP fallback", () => {
  const paseoHome = mkdtempSync(path.join(os.tmpdir(), "paseo-node-client-"));
  cleanup.push(paseoHome);
  mkdirSync(paseoHome, { recursive: true });
  writeFileSync(
    path.join(paseoHome, "paseo.pid"),
    JSON.stringify({ pid: process.pid, listen: "/tmp/paseo.sock" }),
  );
  writeFileSync(
    path.join(paseoHome, "config.json"),
    JSON.stringify({ daemon: { listen: "127.0.0.1:7777" } }),
  );

  expect(resolveDefaultDaemonHosts({ PASEO_HOME: paseoHome })).toEqual([
    "unix:///tmp/paseo.sock",
    "127.0.0.1:7777",
    "localhost:6767",
  ]);
});

test("discovers the running daemon TCP address from its PID record", () => {
  const paseoHome = mkdtempSync(path.join(os.tmpdir(), "paseo-node-client-pid-tcp-"));
  cleanup.push(paseoHome);
  writeFileSync(
    path.join(paseoHome, "paseo.pid"),
    JSON.stringify({ pid: process.pid, listen: "127.0.0.1:7789" }),
  );

  expect(resolveDefaultDaemonHosts({ PASEO_HOME: paseoHome })).toEqual([
    "127.0.0.1:7789",
    "localhost:6767",
  ]);
});

test("normalizes the daemon's bare IPv6 loopback PID address", () => {
  const paseoHome = mkdtempSync(path.join(os.tmpdir(), "paseo-node-client-pid-ipv6-"));
  cleanup.push(paseoHome);
  writeFileSync(
    path.join(paseoHome, "paseo.pid"),
    JSON.stringify({ pid: process.pid, listen: "::1:7789" }),
  );

  expect(resolveDefaultDaemonHosts({ PASEO_HOME: paseoHome })).toEqual([
    "[::1]:7789",
    "localhost:6767",
  ]);
  expect(resolveDaemonTarget("::1:7789")).toEqual({
    type: "tcp",
    url: "ws://[::1]:7789/ws",
  });
});

test("normalizes TCP, Unix, pipe, and Windows path-shaped targets", () => {
  expect(normalizeDaemonHost("tcp://Example.com:6767?ssl=true&password=secret")).toBe(
    "tcp://Example.com:6767?ssl=true&password=secret",
  );
  expect(resolveDaemonTarget("unix:///tmp/paseo.sock")).toEqual({
    type: "ipc",
    url: "ws+unix:///tmp/paseo.sock:/ws",
    socketPath: "/tmp/paseo.sock",
  });
  expect(normalizeDaemonHost("C:\\Users\\fixture\\paseo.sock")).toBeNull();
});

test("keeps explicit and environment passwords process-local", () => {
  expect(resolveDaemonPassword("tcp://localhost:6767?password=query-secret", {})).toBe(
    "query-secret",
  );
  expect(resolveDaemonPassword("localhost:6767", { PASEO_PASSWORD: "env-secret" })).toBe(
    "env-secret",
  );
});

test("preserves the legacy PORT fallback when no listen setting exists", () => {
  const paseoHome = mkdtempSync(path.join(os.tmpdir(), "paseo-node-client-port-"));
  cleanup.push(paseoHome);

  expect(resolveDefaultDaemonHosts({ PASEO_HOME: paseoHome, PORT: "7788" })).toEqual([
    "127.0.0.1:7788",
    "localhost:6767",
  ]);
});

test("skips malformed discovered candidates and keeps the default fallback", () => {
  const paseoHome = mkdtempSync(path.join(os.tmpdir(), "paseo-node-client-malformed-"));
  cleanup.push(paseoHome);
  writeFileSync(path.join(paseoHome, "paseo.pid"), JSON.stringify({ listen: "tcp://bad" }));
  writeFileSync(
    path.join(paseoHome, "config.json"),
    JSON.stringify({ daemon: { listen: "C:\\invalid\\socket" } }),
  );

  expect(
    resolveDefaultDaemonHosts({ PASEO_HOME: paseoHome, PASEO_LISTEN: "tcp://missing-port" }),
  ).toEqual(["localhost:6767"]);
});

test("ignores a stale PID listener before the configured daemon", () => {
  const paseoHome = mkdtempSync(path.join(os.tmpdir(), "paseo-node-client-stale-pid-"));
  cleanup.push(paseoHome);
  writeFileSync(
    path.join(paseoHome, "paseo.pid"),
    JSON.stringify({ pid: 2_147_483_647, listen: "127.0.0.1:7789" }),
  );
  writeFileSync(
    path.join(paseoHome, "config.json"),
    JSON.stringify({ daemon: { listen: "127.0.0.1:7777" } }),
  );

  expect(resolveDefaultDaemonHosts({ PASEO_HOME: paseoHome })).toEqual([
    "127.0.0.1:7777",
    "localhost:6767",
  ]);
});
