import { beforeEach, describe, expect, it } from "vitest";
import {
  claimDraftAutoSubmit,
  releaseDraftAutoSubmit,
  resetDraftAutoSubmitClaimsForTests,
} from "./auto-submit-claim";

describe("claimDraftAutoSubmit", () => {
  beforeEach(() => {
    resetDraftAutoSubmitClaimsForTests();
  });

  it("allows only one concurrent claim per key", () => {
    expect(claimDraftAutoSubmit("s:w:d")).toBe(true);
    expect(claimDraftAutoSubmit("s:w:d")).toBe(false);
  });

  it("allows reclaim after release", () => {
    expect(claimDraftAutoSubmit("s:w:d")).toBe(true);
    releaseDraftAutoSubmit("s:w:d");
    expect(claimDraftAutoSubmit("s:w:d")).toBe(true);
  });

  it("isolates different keys", () => {
    expect(claimDraftAutoSubmit("a")).toBe(true);
    expect(claimDraftAutoSubmit("b")).toBe(true);
  });
});
