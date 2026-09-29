import { describe, expect, it } from "vitest";
import { serializeOnboardingData, type OnboardingData } from "./use-paperclip-onboarding";

describe("usePaperclipOnboarding", () => {
  it("serializes the selected use case and team shape for persistence", () => {
    const data: OnboardingData = {
      useCase: "enterprise",
      teamShape: "large",
      teamName: "Enterprise Team",
    };

    expect(JSON.parse(serializeOnboardingData(data))).toEqual(data);
  });
});
