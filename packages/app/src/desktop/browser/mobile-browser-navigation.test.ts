import { describe, expect, test } from "vitest";
import { resolveMobileBrowserNavigation } from "./mobile-browser-navigation";

describe("Android Browser navigation policy", () => {
  test.each([
    "http://localhost:5173",
    "http://app.localhost:3000",
    "http://127.9.8.7:8000",
    "https://example.com",
    "https://cdn.example.com/app.js",
  ])("allows %s", (url) => {
    expect(resolveMobileBrowserNavigation(url)).toEqual({ kind: "allow" });
  });

  test.each([
    "https://localhost:8443",
    "https://app.localhost",
    "https://[::1]",
    "wss://localhost/socket",
  ])("rejects loopback TLS for %s", (url) => {
    expect(resolveMobileBrowserNavigation(url)).toEqual({ kind: "localhost-tls" });
  });

  test("rejects unsupported protocols", () => {
    expect(resolveMobileBrowserNavigation("file:///tmp/index.html")).toEqual({
      kind: "unsupported-protocol",
      protocol: "file:",
    });
  });

  test.each(["http://0.0.0.0:3000", "http://[::]:3000"])(
    "rejects unspecified listen addresses instead of reaching the phone for %s",
    (url) => {
      expect(resolveMobileBrowserNavigation(url)).toEqual({ kind: "invalid-url" });
    },
  );
});
