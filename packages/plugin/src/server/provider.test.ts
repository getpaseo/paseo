import { describe, expect, test } from "vitest";
import {
  ProviderAvailabilitySchema,
  ProviderEventSchema,
  ProviderInputSchema,
} from "./provider.js";

const TOO_MANY_DENIED_TOOLS = Array.from({ length: 513 }, () => "tool");

describe("plugin provider protocol", () => {
  test("accepts configured catalog inputs and generic denied tools", () => {
    expect(
      ProviderInputSchema.parse({
        type: "catalog",
        requestId: "catalog-1",
        cwd: "/workspace",
        providerOptions: { command: ["omp"] },
        settings: { approval: "ask" },
      }),
    ).toEqual({
      type: "catalog",
      requestId: "catalog-1",
      cwd: "/workspace",
      providerOptions: { command: ["omp"] },
      settings: { approval: "ask" },
    });

    expect(
      ProviderInputSchema.parse({
        type: "session.open",
        requestId: "open-1",
        sessionId: "session-1",
        config: {
          cwd: "/workspace",
          env: {},
          mcpServers: {},
          settings: {},
          deniedTools: ["web_search", "shell"],
          persist: true,
        },
        history: "skip",
      }),
    ).toMatchObject({ config: { deniedTools: ["web_search", "shell"] } });
    expect(() =>
      ProviderInputSchema.parse({
        type: "session.open",
        requestId: "open-2",
        sessionId: "session-2",
        config: {
          cwd: "/workspace",
          env: {},
          mcpServers: {},
          settings: {},
          deniedTools: TOO_MANY_DENIED_TOOLS,
          persist: true,
        },
        history: "skip",
      }),
    ).toThrow();
  });

  test("bounds availability diagnostics and session prompt previews", () => {
    expect(
      ProviderAvailabilitySchema.parse({ status: "incompatible", diagnostic: "upgrade omp" }),
    ).toEqual({ status: "incompatible", diagnostic: "upgrade omp" });
    expect(() =>
      ProviderAvailabilitySchema.parse({ status: "unrunnable", diagnostic: "x".repeat(4_097) }),
    ).toThrow();

    const session = {
      persistence: { version: 1, data: { id: "native" } },
      cwd: "/workspace",
      firstPromptPreview: "first",
      lastPromptPreview: "last",
    };
    expect(
      ProviderEventSchema.parse({ type: "sessions", requestId: "sessions-1", sessions: [session] }),
    ).toMatchObject({ sessions: [session] });
    expect(() =>
      ProviderEventSchema.parse({
        type: "sessions",
        requestId: "sessions-2",
        sessions: [{ ...session, lastPromptPreview: "x".repeat(161) }],
      }),
    ).toThrow();
  });
});
