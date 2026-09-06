import { describe, expect, it } from "vitest";

import { resolveLiveVoiceErrorMessage } from "@/live-voice/live-voice-error-message";

const translate = (key: string) => `t:${key}`;

describe("resolveLiveVoiceErrorMessage", () => {
  it("translates codes whose meaning is fully known to the client", () => {
    expect(resolveLiveVoiceErrorMessage({ code: "busy", message: null }, translate)).toBe(
      "t:liveVoice.errors.busy",
    );
  });

  it("shows the daemon's reason for start_failed instead of a generic string", () => {
    expect(
      resolveLiveVoiceErrorMessage(
        {
          code: "start_failed",
          message: "You've hit your usage limit. Try again at 9:04 PM.",
        },
        translate,
      ),
    ).toBe("You've hit your usage limit. Try again at 9:04 PM.");
  });

  it("falls back to the generic string when the daemon sent no reason", () => {
    expect(resolveLiveVoiceErrorMessage({ code: "start_failed", message: null }, translate)).toBe(
      "t:liveVoice.errors.startFailed",
    );
  });

  it("prefers a server message over the generic string for unknown codes", () => {
    expect(
      resolveLiveVoiceErrorMessage(
        { code: "codex_out_of_credits", message: "No credits" },
        translate,
      ),
    ).toBe("No credits");
  });
});
