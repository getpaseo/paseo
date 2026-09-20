import { describe, expect, it } from "vitest";
import { getErrorMessage, getErrorMessageOr } from "./error-utils.js";

describe("getErrorMessage", () => {
  it("returns Error.message", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns string errors as-is", () => {
    expect(getErrorMessage("plain failure")).toBe("plain failure");
  });

  it("serializes thrown objects instead of [object Object]", () => {
    const thrown = {
      name: "RetriableError",
      message: "[canceled] http/2 stream closed with error code CANCEL (0x8)",
    };
    const message = getErrorMessage(thrown);
    expect(message).toContain("RetriableError");
    expect(message).toContain("CANCEL (0x8)");
    expect(message).not.toBe("[object Object]");
  });

  it("stringifies null and undefined", () => {
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
  });

  it("falls back when JSON.stringify produces an empty object", () => {
    expect(getErrorMessage({})).toBe("Unknown error");
  });
});

describe("getErrorMessageOr", () => {
  it("returns Error.message", () => {
    expect(getErrorMessageOr(new Error("boom"), "fallback")).toBe("boom");
  });

  it("returns the fallback for empty strings and missing values", () => {
    expect(getErrorMessageOr("", "fallback")).toBe("fallback");
    expect(getErrorMessageOr(null, "fallback")).toBe("fallback");
    expect(getErrorMessageOr(undefined, "fallback")).toBe("fallback");
  });

  it("serializes thrown objects instead of [object Object]", () => {
    expect(getErrorMessageOr({ code: "E_CURSOR", details: "reset" }, "fallback")).toBe(
      '{"code":"E_CURSOR","details":"reset"}',
    );
  });

  it("returns the fallback for empty objects", () => {
    expect(getErrorMessageOr({}, "fallback")).toBe("fallback");
  });
});
