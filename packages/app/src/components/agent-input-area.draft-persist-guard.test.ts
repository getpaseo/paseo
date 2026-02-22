import { describe, expect, it } from "vitest";
import { shouldSkipDraftPersist } from "./agent-input-area.draft-persist-guard";

describe("shouldSkipDraftPersist", () => {
  it("blocks persist while hydrate for current uncontrolled generation is incomplete", () => {
    expect(
      shouldSkipDraftPersist({
        isControlled: false,
        currentGeneration: 2,
        hydratedGeneration: 1,
        isCurrentGeneration: true,
      })
    ).toBe(true);
  });

  it("allows persist after hydrate completes for current generation", () => {
    expect(
      shouldSkipDraftPersist({
        isControlled: false,
        currentGeneration: 3,
        hydratedGeneration: 3,
        isCurrentGeneration: true,
      })
    ).toBe(false);
  });

  it("blocks persist for stale generations", () => {
    expect(
      shouldSkipDraftPersist({
        isControlled: false,
        currentGeneration: 4,
        hydratedGeneration: 4,
        isCurrentGeneration: false,
      })
    ).toBe(true);
  });

  it("does not block controlled draft persistence", () => {
    expect(
      shouldSkipDraftPersist({
        isControlled: true,
        currentGeneration: 0,
        hydratedGeneration: 0,
        isCurrentGeneration: true,
      })
    ).toBe(false);
  });
});
