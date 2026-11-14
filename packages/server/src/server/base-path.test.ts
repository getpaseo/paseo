import { describe, expect, test } from "vitest";

import { isDaemonWebSocketPath, normalizeBasePath, stripBasePath } from "./base-path.js";

describe("normalizeBasePath", () => {
  test.each([
    [undefined, ""],
    ["", ""],
    ["/", ""],
    ["  ", ""],
    ["/paseo", "/paseo"],
    ["/user/alice/paseo/", "/user/alice/paseo"],
    ["//user//alice/", "/user/alice"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeBasePath(input)).toBe(expected);
  });

  test.each(["paseo", "/a/../b", "/a/./b", "/a?b", "/a#b", "/a b", "\\\\a"])(
    "rejects %j",
    (input) => {
      expect(() => normalizeBasePath(input)).toThrow(/Invalid base path/);
    },
  );
});

describe("stripBasePath", () => {
  const basePath = "/user/alice/paseo";

  test.each([
    ["/user/alice/paseo", "/"],
    ["/user/alice/paseo/", "/"],
    ["/user/alice/paseo?x=1", "/?x=1"],
    ["/user/alice/paseo/_expo/a.js", "/_expo/a.js"],
    ["/user/alice/paseo/ws?x=1", "/ws?x=1"],
  ])("strips %j to %j", (url, expected) => {
    expect(stripBasePath(url, basePath)).toBe(expected);
  });

  test.each(["/", "/ws", "/user/alice/paseo-other/a.js", "/user/alice"])(
    "leaves %j outside the base path",
    (url) => {
      expect(stripBasePath(url, basePath)).toBeNull();
    },
  );

  test("is a no-op without a base path", () => {
    expect(stripBasePath("/ws", "")).toBeNull();
  });
});

describe("isDaemonWebSocketPath", () => {
  test("matches the root endpoint with or without a base path", () => {
    expect(isDaemonWebSocketPath("/ws", "")).toBe(true);
    expect(isDaemonWebSocketPath("/ws?clientId=a", "/paseo")).toBe(true);
  });

  test("matches the prefixed endpoint only when a base path is set", () => {
    expect(isDaemonWebSocketPath("/paseo/ws", "/paseo")).toBe(true);
    expect(isDaemonWebSocketPath("/paseo/ws", "")).toBe(false);
    expect(isDaemonWebSocketPath("/other/ws", "/paseo")).toBe(false);
    expect(isDaemonWebSocketPath(undefined, "/paseo")).toBe(false);
  });
});
