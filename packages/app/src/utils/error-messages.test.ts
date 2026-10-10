import { describe, expect, it } from "vitest";

import { toErrorMessage } from "./error-messages";

describe("toErrorMessage", () => {
  it("keeps an Error message", () => {
    expect(toErrorMessage(new Error("Connection lost"))).toBe("Connection lost");
  });

  it("uses a serialized error message", () => {
    expect(toErrorMessage({ message: "Request cancelled" })).toBe("Request cancelled");
  });

  it("uses a serialized error fallback", () => {
    expect(toErrorMessage({ error: "Request cancelled" })).toBe("Request cancelled");
  });

  it("does not expose an object string as an inline error", () => {
    expect(toErrorMessage({ code: "REQUEST_CANCELLED" })).toBe("Unknown error");
  });
});
