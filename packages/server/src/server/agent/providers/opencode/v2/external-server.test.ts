import { describe, expect, test } from "vitest";

import {
  EXTERNAL_SERVER_PASSWORD_ENV,
  EXTERNAL_SERVER_URL_ENV,
  resolveExternalOpenCodeServer,
} from "./external-server.js";

describe("resolveExternalOpenCodeServer", () => {
  test("returns undefined when no URL is configured", () => {
    expect(resolveExternalOpenCodeServer(undefined)).toBeUndefined();
    expect(resolveExternalOpenCodeServer({ [EXTERNAL_SERVER_URL_ENV]: "   " })).toBeUndefined();
  });

  test("reads the URL and password and removes a trailing slash", () => {
    expect(
      resolveExternalOpenCodeServer({
        [EXTERNAL_SERVER_URL_ENV]: " http://127.0.0.1:4096/ ",
        [EXTERNAL_SERVER_PASSWORD_ENV]: "secret",
      }),
    ).toEqual({ url: "http://127.0.0.1:4096", password: "secret" });
  });

  test("omits an empty password", () => {
    expect(
      resolveExternalOpenCodeServer({
        [EXTERNAL_SERVER_URL_ENV]: "https://opencode.example.com",
        [EXTERNAL_SERVER_PASSWORD_ENV]: "",
      }),
    ).toEqual({ url: "https://opencode.example.com" });
  });

  test("preserves spaces in the password", () => {
    expect(
      resolveExternalOpenCodeServer({
        [EXTERNAL_SERVER_URL_ENV]: "https://opencode.example.com",
        [EXTERNAL_SERVER_PASSWORD_ENV]: " secret ",
      }),
    ).toEqual({ url: "https://opencode.example.com", password: " secret " });
  });

  test("rejects relative and non-HTTP URLs", () => {
    expect(() =>
      resolveExternalOpenCodeServer({ [EXTERNAL_SERVER_URL_ENV]: "127.0.0.1:4096" }),
    ).toThrow(`${EXTERNAL_SERVER_URL_ENV} must be an absolute URL, received "127.0.0.1:4096"`);
    expect(() =>
      resolveExternalOpenCodeServer({ [EXTERNAL_SERVER_URL_ENV]: "unix:/tmp/opencode.sock" }),
    ).toThrow(
      `${EXTERNAL_SERVER_URL_ENV} must use http or https, received "unix:/tmp/opencode.sock"`,
    );
  });

  test("rejects credentials embedded in URLs", () => {
    expect(() =>
      resolveExternalOpenCodeServer({
        [EXTERNAL_SERVER_URL_ENV]: "https://user:password@opencode.example.com",
      }),
    ).toThrow("must not contain credentials");
  });
});
