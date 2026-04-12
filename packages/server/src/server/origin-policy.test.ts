import { describe, expect, test } from "vitest";

import { isOriginAllowed, isSameHostOrigin } from "./origin-policy.js";

describe("origin policy", () => {
  test("allows same host across different ports", () => {
    expect(isSameHostOrigin("http://192.0.2.10:5173", "192.0.2.10:6767")).toBe(true);
    expect(isSameHostOrigin("https://devbox.example.test:8443", "devbox.example.test:6767")).toBe(
      true,
    );
  });

  test("rejects different hosts unless explicitly allowlisted", () => {
    expect(
      isOriginAllowed({
        origin: "http://127.0.0.1:5173",
        requestHost: "192.0.2.10:6767",
        allowedOrigins: new Set<string>(),
      }),
    ).toBe(false);

    expect(
      isOriginAllowed({
        origin: "http://127.0.0.1:5173",
        requestHost: "192.0.2.10:6767",
        allowedOrigins: new Set<string>(["http://127.0.0.1:5173"]),
      }),
    ).toBe(true);
  });

  test("allows missing origin for native and CLI clients", () => {
    expect(
      isOriginAllowed({
        origin: undefined,
        requestHost: "192.0.2.10:6767",
        allowedOrigins: new Set<string>(),
      }),
    ).toBe(true);
  });
});
