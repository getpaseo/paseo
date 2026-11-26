import { describe, expect, it } from "vitest";
import {
  ProviderEventSchema,
  ProviderInputSchema,
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderEvent,
  type ProviderInput,
  type ProviderMetric,
} from "./provider.js";

type ReviewMode = "uncommitted" | "base" | "all";
type Delivery = "auto" | "steer";

const contextLine = {
  oldLineNumber: null,
  newLineNumber: 12,
  type: "add",
  content: "const value = 1;",
} as const;

function reviewPrompt(mode: ReviewMode, delivery: Delivery): ProviderInput {
  return {
    type: "session.prompt",
    sessionId: "session-1",
    prompt: {
      clientMessageId: "message-1",
      delivery,
      input: {
        type: "message",
        content: [
          {
            type: "review",
            mimeType: "application/paseo-review",
            cwd: "/workspace",
            mode,
            baseRef: "main",
            comments: [
              {
                filePath: "src/index.ts",
                side: "new",
                lineNumber: 12,
                body: "Please review this change.",
                context: {
                  hunkHeader: "@@ -10,2 +10,3 @@",
                  targetLine: contextLine,
                  lines: [{ ...contextLine, type: "context", oldLineNumber: 11 }, contextLine],
                },
              },
            ],
          },
        ],
      },
    },
  };
}

describe("Provider review attachments", () => {
  it.each(["uncommitted", "base", "all"] as const)(
    "preserves mode %s on an ordinary prompt",
    (mode) => {
      const input = reviewPrompt(mode, "auto");
      expect(ProviderInputSchema.parse(input)).toEqual(input);
    },
  );

  it.each(["uncommitted", "base", "all"] as const)(
    "preserves mode %s on a steering prompt",
    (mode) => {
      const input = reviewPrompt(mode, "steer");
      expect(ProviderInputSchema.parse(input)).toEqual(input);
    },
  );
});

describe("Provider metrics", () => {
  const metrics: ProviderMetric[] = [
    { label: "Model", value: "agent-large" },
    { label: "Cache", value: "82%", tone: "ok" },
  ];

  it("publishes the session's metrics as one replaceable list", () => {
    const event: ProviderEvent = { type: "session.metrics", sessionId: "session-1", metrics };
    expect(ProviderEventSchema.parse(event)).toEqual(event);
  });

  it("attaches metrics to the turn they describe when it completes", () => {
    const event: ProviderEvent = {
      type: "session.turn",
      sessionId: "session-1",
      turnId: "turn-1",
      state: "completed",
      metrics,
    };
    expect(ProviderEventSchema.parse(event)).toEqual(event);
  });

  it("keeps completing turns without metrics", () => {
    const event: ProviderEvent = {
      type: "session.turn",
      sessionId: "session-1",
      turnId: "turn-1",
      state: "completed",
    };
    expect(ProviderEventSchema.parse(event)).toEqual(event);
  });

  it("tells a provider whether this Paseo shows session metrics", () => {
    const supported = ["prompt.message", "session.metrics"] as const;
    expect(
      negotiateProviderCapabilities(["prompt.message", "session.metrics"], supported),
    ).toContain("session.metrics");
    // A Paseo from before session metrics never offers them.
    expect(negotiateProviderCapabilities(["prompt.message"], supported)).toEqual([
      "prompt.message",
    ]);
  });

  it("refuses a metric whose value is not text Paseo can show as given", () => {
    expect(
      ProviderEventSchema.safeParse({
        type: "session.metrics",
        sessionId: "session-1",
        metrics: [{ label: "Cost", value: 1.23 }],
      }).success,
    ).toBe(false);
  });
});

describe("Provider launch wrap", () => {
  const open = (wrap?: readonly [string, ...string[]]): ProviderInput =>
    ProviderInputSchema.parse({
      type: "session.open",
      requestId: "open",
      sessionId: "session-1",
      history: "skip",
      config: {
        cwd: "/workspace",
        env: {},
        mcpServers: {},
        settings: {},
        persist: true,
        ...(wrap ? { wrap } : {}),
      },
    });

  it("requires session.launch_wrap only for an open that carries a wrap", () => {
    expect(() => requireProviderCapabilities([], open(["/bin/sandbox", "a b"]))).toThrow(
      "session.launch_wrap",
    );
    expect(() =>
      requireProviderCapabilities(["session.launch_wrap"], open(["/bin/sandbox"])),
    ).not.toThrow();
    expect(() => requireProviderCapabilities([], open())).not.toThrow();
  });

  it("keeps each wrap element whole and rejects an empty wrap", () => {
    expect(open(["/bin/sandbox", "a b"])).toMatchObject({
      config: { wrap: ["/bin/sandbox", "a b"] },
    });
    expect(() => open([] as unknown as [string])).toThrow();
  });
});
