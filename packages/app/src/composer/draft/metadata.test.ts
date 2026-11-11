import { describe, expect, it } from "vitest";
import { applyMetadataPatch } from "./metadata";

describe("applyMetadataPatch", () => {
  it("replaces top-level keys and removes keys patched to null", () => {
    expect(
      applyMetadataPatch(
        { "linear.issue": { id: "ENG-1" }, review: true },
        { "linear.issue": { id: "ENG-2" }, review: null, extra: [1] },
      ),
    ).toEqual({ "linear.issue": { id: "ENG-2" }, extra: [1] });
  });

  it("leaves the current record untouched", () => {
    const current = { review: true };
    applyMetadataPatch(current, { review: null });
    expect(current).toEqual({ review: true });
  });
});
