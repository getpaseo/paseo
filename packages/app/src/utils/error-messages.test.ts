import { describe, expect, it } from "vitest";

import { toErrorMessage } from "./error-messages";

describe("toErrorMessage", () => {
  it("reads Error.message", () => {
    expect(toErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("unwraps ACP-style plain objects instead of [object Object]", () => {
    expect(
      toErrorMessage({
        message: "Invalid params",
        code: -32602,
        data: { message: "Invalid value for thinking: high" },
      }),
    ).toBe("Invalid params: Invalid value for thinking: high");
  });
});
