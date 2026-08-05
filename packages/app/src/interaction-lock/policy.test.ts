import { describe, expect, it } from "vitest";
import { resolveComposerInteractionPolicy } from "./policy";

describe("resolveComposerInteractionPolicy", () => {
  it("allows all actions when unlocked", () => {
    expect(resolveComposerInteractionPolicy({ locked: false })).toEqual({
      canEdit: true,
      canSend: true,
      canQueue: true,
      canChangeControls: true,
      canStartVoice: true,
      canRespondToPermissions: true,
      canMutateAgent: true,
      canNavigate: true,
    });
  });

  it("blocks mutating and navigation actions when locked", () => {
    expect(resolveComposerInteractionPolicy({ locked: true })).toEqual({
      canEdit: false,
      canSend: false,
      canQueue: false,
      canChangeControls: false,
      canStartVoice: false,
      canRespondToPermissions: false,
      canMutateAgent: false,
      canNavigate: false,
    });
  });
});
