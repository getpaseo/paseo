import { describe, expect, it } from "vitest";
import { validateCron } from "./schedule-format";

describe("validateCron", () => {
  it("rejects step fields with extra slash tokens", () => {
    expect(validateCron("*/5/2 * * * *")).toBe("Invalid minute step");
  });
});
