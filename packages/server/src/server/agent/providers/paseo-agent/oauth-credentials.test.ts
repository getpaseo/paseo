import { describe, expect, it } from "vitest";

import {
  isRefreshTokenExpressionConfigured,
  resolveRefreshTokenExpression,
} from "./oauth-credentials.js";

describe("resolveRefreshTokenExpression", () => {
  it("returns a literal value", async () => {
    await expect(resolveRefreshTokenExpression("rt-literal", {})).resolves.toBe("rt-literal");
  });

  it("resolves an env reference and returns undefined when unset", async () => {
    await expect(resolveRefreshTokenExpression("$CODEX_RT", { CODEX_RT: "rt-env" })).resolves.toBe(
      "rt-env",
    );
    await expect(
      resolveRefreshTokenExpression("${CODEX_RT}", { CODEX_RT: "rt-env" }),
    ).resolves.toBe("rt-env");
    await expect(resolveRefreshTokenExpression("$CODEX_RT", {})).resolves.toBeUndefined();
  });

  it("runs a !command asynchronously and returns its trimmed output", async () => {
    await expect(resolveRefreshTokenExpression("!printf rt-cmd", {})).resolves.toBe("rt-cmd");
    await expect(resolveRefreshTokenExpression("!exit 1", {})).resolves.toBeUndefined();
  });
});

describe("isRefreshTokenExpressionConfigured", () => {
  it("is true for a literal and a set env var, false for an unset env var", () => {
    expect(isRefreshTokenExpressionConfigured("rt", {})).toBe(true);
    expect(isRefreshTokenExpressionConfigured("$RT", { RT: "x" })).toBe(true);
    expect(isRefreshTokenExpressionConfigured("$RT", {})).toBe(false);
  });

  it("assumes a !command is runnable without executing it", () => {
    expect(isRefreshTokenExpressionConfigured("!exit 1", {})).toBe(true);
  });
});
