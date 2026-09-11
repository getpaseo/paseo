import { describe, expect, it } from "vitest";

import { deriveFallbackToolCallInput } from "./tool-call-details-input";

describe("tool call details input", () => {
  it("derives read parameters when a daemon does not send raw input", () => {
    expect(
      deriveFallbackToolCallInput({
        type: "read",
        filePath: "/workspace/src/main.rs",
        offset: 20,
        limit: 40,
      }),
    ).toEqual({ path: "/workspace/src/main.rs", offset: 20, limit: 40 });
  });

  it("derives the search query without empty optional fields", () => {
    expect(
      deriveFallbackToolCallInput({
        type: "search",
        query: "/workspace",
        toolName: "search",
      }),
    ).toEqual({ query: "/workspace" });
  });

  it("does not duplicate tool kinds that already render their inputs", () => {
    expect(deriveFallbackToolCallInput({ type: "shell", command: "pwd" })).toBeUndefined();
    expect(
      deriveFallbackToolCallInput({ type: "unknown", input: { path: "/workspace" }, output: null }),
    ).toBeUndefined();
  });
});
