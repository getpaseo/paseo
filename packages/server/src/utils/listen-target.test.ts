import { describe, expect, test } from "vitest";

import { parseListenString } from "./listen-target.js";

describe("parseListenString", () => {
  test("parses whitespace-padded numeric port strings", () => {
    expect(parseListenString(" 6767 ")).toEqual({
      type: "tcp",
      host: "127.0.0.1",
      port: 6767,
    });
  });

  test("parses IPv6 listen targets correctly", () => {
    expect(parseListenString("[::1]:6767")).toEqual({
      type: "tcp",
      host: "::1",
      port: 6767,
    });
    expect(parseListenString("[::]:6767")).toEqual({
      type: "tcp",
      host: "::",
      port: 6767,
    });
  });

  test("rejects Windows absolute paths that are not named pipes", () => {
    expect(() => parseListenString(String.raw`C:\daemon`)).toThrow();
    expect(() => parseListenString(String.raw`D:\Users\foo\.paseo\daemon.sock`)).toThrow();
    expect(() => parseListenString(String.raw`C:\some\path`)).toThrow();
  });

  test("parses Windows named pipes as managed IPC listen targets", () => {
    expect(parseListenString(String.raw`\\.\pipe\paseo-managed-test`)).toEqual({
      type: "pipe",
      path: String.raw`\\.\pipe\paseo-managed-test`,
    });
    expect(parseListenString(`pipe://${String.raw`\\.\pipe\paseo-managed-test`}`)).toEqual({
      type: "pipe",
      path: String.raw`\\.\pipe\paseo-managed-test`,
    });
  });
});
