import { describe, expect, it } from "vitest";
import { shouldShowMergedArchiveAction } from "./merged-archive-action";
import type { PrHint } from "@/git/pr-hint";

function prHint(state: PrHint["state"]): PrHint {
  return {
    url: `https://github.com/acme/widgets/pull/7`,
    number: 7,
    state,
    forge: "github",
  };
}

describe("shouldShowMergedArchiveAction", () => {
  it("shows on a merged change request that can still be archived", () => {
    expect(
      shouldShowMergedArchiveAction({
        prHint: prHint("merged"),
        hasArchiveAction: true,
        archiveStatus: "idle",
      }),
    ).toBe(true);
  });

  it("stays hidden for every state that is not merged", () => {
    for (const state of ["open", "closed"] as const) {
      expect(
        shouldShowMergedArchiveAction({
          prHint: prHint(state),
          hasArchiveAction: true,
          archiveStatus: "idle",
        }),
      ).toBe(false);
    }
    expect(
      shouldShowMergedArchiveAction({
        prHint: null,
        hasArchiveAction: true,
        archiveStatus: "idle",
      }),
    ).toBe(false);
  });

  it("stays hidden once the archive is under way, and where archiving is unavailable", () => {
    expect(
      shouldShowMergedArchiveAction({
        prHint: prHint("merged"),
        hasArchiveAction: true,
        archiveStatus: "pending",
      }),
    ).toBe(false);
    expect(
      shouldShowMergedArchiveAction({
        prHint: prHint("merged"),
        hasArchiveAction: false,
        archiveStatus: "idle",
      }),
    ).toBe(false);
  });
});
