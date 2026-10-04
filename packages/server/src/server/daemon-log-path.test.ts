import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_DAEMON_LOG_FILENAME, resolveDaemonLogPath } from "./daemon-log-path.js";

const paseoHome = path.join(path.sep, "tmp", "paseo-log-path-tests");

describe("resolveDaemonLogPath", () => {
  it("defaults to daemon.log in PASEO_HOME", () => {
    const expected = path.join(paseoHome, DEFAULT_DAEMON_LOG_FILENAME);

    expect(resolveDaemonLogPath(paseoHome)).toBe(expected);
    expect(resolveDaemonLogPath(paseoHome, {})).toBe(expected);
    expect(resolveDaemonLogPath(paseoHome, { log: {} })).toBe(expected);
    expect(resolveDaemonLogPath(paseoHome, { log: { file: {} } })).toBe(expected);
  });

  it("uses an absolute configured path as-is", () => {
    const absolute = path.join(path.sep, "var", "log", "paseo", "daemon.log");

    expect(resolveDaemonLogPath(paseoHome, { log: { file: { path: absolute } } })).toBe(absolute);
  });

  it("resolves a relative configured path against PASEO_HOME", () => {
    expect(resolveDaemonLogPath(paseoHome, { log: { file: { path: "logs/daemon.log" } } })).toBe(
      path.resolve(paseoHome, "logs", "daemon.log"),
    );
    expect(
      resolveDaemonLogPath(paseoHome, { log: { file: { path: "../shared/daemon.log" } } }),
    ).toBe(path.resolve(paseoHome, "..", "shared", "daemon.log"));
  });
});
