import { describe, expect, test, vi } from "vitest";

import {
  createCursorContextUsageResolver,
  estimateCursorContextTokens,
  resolveCursorContextWindowMaxTokens,
  transformCursorModelDefinition,
} from "./cursor-context-usage.js";

describe("Cursor context usage", () => {
  test("resolves parameterized, metadata, and default context limits", () => {
    expect(
      resolveCursorContextWindowMaxTokens("gpt-5.4[context=272k,reasoning=medium,fast=false]"),
    ).toBe(272_000);
    expect(
      resolveCursorContextWindowMaxTokens("future-model", { totalContextTokens: 1_000_000 }),
    ).toBe(1_000_000);
    expect(resolveCursorContextWindowMaxTokens("composer-2.5")).toBe(200_000);
  });

  test("adds the context limit to Cursor model definitions", () => {
    const definition = transformCursorModelDefinition(
      {
        modelId: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
        name: "gpt-5.4",
      },
      {
        provider: "acp",
        id: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
        label: "gpt-5.4",
      },
    );

    expect(definition.contextWindowMaxTokens).toBe(272_000);
  });

  test("estimates ASCII and non-ASCII session content", () => {
    expect(estimateCursorContextTokens(["12345678", "你好"])).toBe(12);
  });

  test("builds estimated usage from persisted Cursor messages", () => {
    const readSessionMessages = vi.fn(() => ["a".repeat(4000), "你好"]);
    const resolveUsage = createCursorContextUsageResolver({ readSessionMessages });

    expect(
      resolveUsage({
        sessionId: "b9a44fcf-387c-42e4-8572-6a4547939c30",
        cwd: "/tmp/project",
        modelId: "composer-2.5",
        usage: { inputTokens: 20 },
      }),
    ).toEqual({
      inputTokens: 20,
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 1010,
      contextWindowEstimated: true,
    });
    expect(readSessionMessages).toHaveBeenCalledWith("b9a44fcf-387c-42e4-8572-6a4547939c30");
  });

  test("keeps the catalog's model-specific context limit for estimated usage", () => {
    const resolveUsage = createCursorContextUsageResolver({
      readSessionMessages: () => ["message"],
      resolveContextWindowMaxTokens: (modelId) =>
        modelId === "gpt-context-300k" ? 300_000 : undefined,
    });

    expect(
      resolveUsage({
        sessionId: "b9a44fcf-387c-42e4-8572-6a4547939c30",
        cwd: "/tmp/project",
        modelId: "gpt-context-300k",
        usage: undefined,
      }),
    ).toMatchObject({
      contextWindowMaxTokens: 300_000,
      contextWindowEstimated: true,
    });
  });

  test("never reports an estimated context larger than the selected window", () => {
    const resolveUsage = createCursorContextUsageResolver({
      readSessionMessages: () => ["a".repeat(1_000_000)],
      resolveContextWindowMaxTokens: () => 200_000,
    });

    expect(
      resolveUsage({
        sessionId: "b9a44fcf-387c-42e4-8572-6a4547939c30",
        cwd: "/tmp/project",
        modelId: "composer-2.5",
        usage: undefined,
      }),
    ).toMatchObject({
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 200_000,
      contextWindowEstimated: true,
    });
  });

  test("never replaces native ACP context usage", () => {
    const nativeUsage = {
      contextWindowMaxTokens: 128_000,
      contextWindowUsedTokens: 42_000,
      contextWindowEstimated: false,
    };
    const readSessionMessages = vi.fn(() => ["ignored"]);
    const resolveUsage = createCursorContextUsageResolver({ readSessionMessages });

    expect(
      resolveUsage({
        sessionId: "b9a44fcf-387c-42e4-8572-6a4547939c30",
        cwd: "/tmp/project",
        modelId: "composer-2.5",
        usage: nativeUsage,
      }),
    ).toBe(nativeUsage);
    expect(readSessionMessages).not.toHaveBeenCalled();
  });
});
