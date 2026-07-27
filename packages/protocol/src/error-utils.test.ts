import { describe, expect, it } from "vitest";

import { getErrorMessage, getErrorMessageOr } from "./error-utils.js";

describe("getErrorMessage", () => {
  it("reads Error.message", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns string errors as-is", () => {
    expect(getErrorMessage("plain failure")).toBe("plain failure");
  });

  it("unwraps ACP-style objects with nested data.message", () => {
    expect(
      getErrorMessage({
        message: "Invalid params",
        code: -32602,
        data: { message: "Invalid value for thinking: high" },
      }),
    ).toBe("Invalid params: Invalid value for thinking: high");
  });

  it("uses top-level message when data.message is absent", () => {
    expect(getErrorMessage({ message: "Password required", code: 401 })).toBe("Password required");
  });

  it("never collapses plain objects to [object Object]", () => {
    expect(getErrorMessage({ code: 42 })).toBe('{"code":42}');
    expect(getErrorMessage({})).toBe("Unknown error");
  });
});

describe("getErrorMessageOr", () => {
  it("falls back when nothing useful is present", () => {
    expect(getErrorMessageOr(null, "fallback")).toBe("fallback");
    expect(getErrorMessageOr("", "fallback")).toBe("fallback");
  });

  it("prefers object message over the fallback", () => {
    expect(getErrorMessageOr({ message: "Nope" }, "fallback")).toBe("Nope");
  });
});
