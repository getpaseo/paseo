import { describe, expect, it } from "vitest";
import { summarizePaperclipPrompt } from "./prompt";

const BOSS = { "paseo.origin": "paperclip:Boss" };

describe("summarizePaperclipPrompt", () => {
  it("names the task of an adapter heartbeat from the agent title", () => {
    expect(
      summarizePaperclipPrompt({
        message:
          "A new Paperclip heartbeat started. Reload $PAPERCLIP_ENV_FILE before calling Paperclip.",
        agentLabels: BOSS,
        agentTitle: "Boss · VIZ-35 Automatischer Modell- und Kontowechsel bei Limits",
      }),
    ).toEqual({ issueKey: "VIZ-35", title: "Automatischer Modell- und Kontowechsel bei Limits" });
  });

  it("leaves the person's own messages and non-Paperclip sessions alone", () => {
    expect(
      summarizePaperclipPrompt({
        message: "Bitte VIZ-35 priorisieren",
        agentLabels: BOSS,
        agentTitle: "Boss · VIZ-35 X",
      }),
    ).toBeNull();
    expect(
      summarizePaperclipPrompt({
        message: "You are a Paperclip agent running as a Paseo session.",
        agentLabels: { "paseo.origin": "user" },
        agentTitle: "Anything",
      }),
    ).toBeNull();
  });
});
