import { describe, expect, test } from "vitest";

import {
  isACPProviderSessionInvalidError,
  isACPProviderSessionInvalidText,
} from "./acp-session-invalid.js";

describe("isACPProviderSessionInvalidText", () => {
  test("matches the Kimi engine runtime binding failure render", () => {
    expect(
      isACPProviderSessionInvalidText(
        "Error: [internal] runtime acp:session_1e02711b-7d6f-496b-af8b-a44a27f91ad8 does not exist in workspace wd_clinicalextractor_46f49d607365",
      ),
    ).toBe(true);
  });

  test("matches the engine runtime error code and resolver renders", () => {
    expect(isACPProviderSessionInvalidText("runtime.not_found while acquiring the runtime")).toBe(
      true,
    );
    expect(
      isACPProviderSessionInvalidText(
        "runtime binding workspace wd_a_1 does not match session workspace wd_b_2",
      ),
    ).toBe(true);
    expect(isACPProviderSessionInvalidText("workspace wd_a_1 is not materialized")).toBe(true);
    expect(isACPProviderSessionInvalidText("session session_1 is not live")).toBe(true);
    expect(isACPProviderSessionInvalidText('Unknown sessionId: "session_1"')).toBe(true);
    expect(isACPProviderSessionInvalidText("SESSION_NOT_FOUND: gone")).toBe(true);
    expect(isACPProviderSessionInvalidText("session_not_found while loading")).toBe(true);
  });

  test("does not match unrelated provider errors", () => {
    expect(isACPProviderSessionInvalidText("session prompt failed")).toBe(false);
    expect(isACPProviderSessionInvalidText("auth.login_required")).toBe(false);
    expect(isACPProviderSessionInvalidText("ACP initialize timed out after 20000ms")).toBe(false);
    expect(isACPProviderSessionInvalidText("")).toBe(false);
  });

  test("does not match normal assistant prose about workspaces", () => {
    expect(
      isACPProviderSessionInvalidText("The workspace wd_a_1 contains three source files."),
    ).toBe(false);
  });
});

describe("isACPProviderSessionInvalidError", () => {
  test("classifies Error instances carrying a session-invalid message", () => {
    expect(
      isACPProviderSessionInvalidError(
        new Error("runtime acp:session_1 does not exist in workspace wd_a_1"),
      ),
    ).toBe(true);
  });

  test("classifies raw JSON-RPC rejection objects, which the ACP SDK resolves with", () => {
    expect(
      isACPProviderSessionInvalidError({
        code: -32000,
        message: "runtime acp:session_1 does not exist in workspace wd_a_1",
      }),
    ).toBe(true);
    expect(
      isACPProviderSessionInvalidError({
        code: -32603,
        message: "Internal error",
        data: { details: "Unknown sessionId: session_1" },
      }),
    ).toBe(true);
  });

  test("passes through non-error values and unrelated messages", () => {
    expect(isACPProviderSessionInvalidError(undefined)).toBe(false);
    expect(isACPProviderSessionInvalidError("runtime.not_found")).toBe(false);
    expect(isACPProviderSessionInvalidError(new Error("connection closed"))).toBe(false);
    expect(
      isACPProviderSessionInvalidError({ code: -32000, message: "session prompt failed" }),
    ).toBe(false);
  });
});
