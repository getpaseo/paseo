import { describe, expect, test } from "vitest";
import {
  PROVIDER_CAPABILITIES,
  ProviderEventSchema,
  negotiateProviderCapabilities,
} from "./provider.js";

describe("provider subagent presentation", () => {
  test("accepts a provider-owned subtitle on session.opened", () => {
    const event = ProviderEventSchema.parse({
      type: "session.opened",
      sessionId: "child",
      parentSessionId: "root",
      capabilities: [],
      restoration: "parent",
      subtitle: "general-purpose · Opus 5.5 · Medium · 1 tokens",
      cwd: "/workspace",
    });
    expect(event).toMatchObject({
      type: "session.opened",
      subtitle: "general-purpose · Opus 5.5 · Medium · 1 tokens",
    });
  });

  test("parses session.opened without a subtitle", () => {
    const event = ProviderEventSchema.parse({
      type: "session.opened",
      sessionId: "child",
      parentSessionId: "root",
      capabilities: [],
      restoration: "parent",
      cwd: "/workspace",
    });
    expect(event.type).toBe("session.opened");
    expect("subtitle" in event).toBe(false);
  });

  test("accepts presentation updates that replace or clear the subtitle", () => {
    expect(
      ProviderEventSchema.parse({
        type: "session.subagent_presentation",
        sessionId: "child",
        subtitle: "general-purpose · Opus 5.5 · Medium · 2k tokens",
      }),
    ).toEqual({
      type: "session.subagent_presentation",
      sessionId: "child",
      subtitle: "general-purpose · Opus 5.5 · Medium · 2k tokens",
    });
    expect(
      ProviderEventSchema.parse({
        type: "session.subagent_presentation",
        sessionId: "child",
        subtitle: null,
      }),
    ).toEqual({ type: "session.subagent_presentation", sessionId: "child", subtitle: null });
  });

  test("advertises the presentation capability for negotiation", () => {
    expect(PROVIDER_CAPABILITIES).toContain("session.subagent_presentation");
    expect(
      negotiateProviderCapabilities(
        ["session.subagent_presentation", "prompt.message", "unknown.capability"],
        PROVIDER_CAPABILITIES,
      ),
    ).toEqual(["session.subagent_presentation", "prompt.message"]);
  });
});
