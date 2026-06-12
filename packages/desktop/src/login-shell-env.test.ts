import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RESOLVE_TIMEOUT_MS, getResolveTimeoutMs } from "./login-shell-env";

vi.mock("electron-log/main", () => ({
  default: { info: vi.fn(), warn: vi.fn() },
}));

describe("getResolveTimeoutMs", () => {
  const KEY = "PASEO_SHELL_ENV_TIMEOUT_MS";
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[KEY];
    } else {
      process.env[KEY] = original;
    }
  });

  it("defaults when the override is unset", () => {
    delete process.env[KEY];
    expect(getResolveTimeoutMs()).toBe(DEFAULT_RESOLVE_TIMEOUT_MS);
  });

  it("honors a positive override", () => {
    process.env[KEY] = "45000";
    expect(getResolveTimeoutMs()).toBe(45_000);
  });

  it("parses scientific notation rather than truncating it", () => {
    process.env[KEY] = "60e3";
    expect(getResolveTimeoutMs()).toBe(60_000);
  });

  it("falls back on non-numeric values", () => {
    process.env[KEY] = "soon";
    expect(getResolveTimeoutMs()).toBe(DEFAULT_RESOLVE_TIMEOUT_MS);
  });

  it("falls back on non-positive values", () => {
    process.env[KEY] = "0";
    expect(getResolveTimeoutMs()).toBe(DEFAULT_RESOLVE_TIMEOUT_MS);
  });
});
