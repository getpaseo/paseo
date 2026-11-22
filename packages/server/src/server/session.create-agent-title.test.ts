import { describe, expect, test } from "vitest";

import { resolveCreateAgentTitles } from "./agent/create-agent-title.js";

describe("resolveCreateAgentTitles", () => {
  test("ends an overlong initial title at a complete word and marks omitted text", () => {
    expect(
      resolveCreateAgentTitles({
        initialPrompt: "scan brevo, pushowl slack, jiras, notions and list the biggest issues",
      }).provisionalTitle,
    ).toBe("scan brevo, pushowl slack, jiras, notions and list the…");
  });

  test.each([
    ["a".repeat(60), "a".repeat(60)],
    ["a".repeat(59) + " remainder", "a".repeat(59) + "…"],
    ["a".repeat(60) + " remainder", "a".repeat(59) + "…"],
    ["a".repeat(61) + " remainder", "a".repeat(59) + "…"],
    ["a".repeat(61), "a".repeat(59) + "…"],
    ["a".repeat(58) + "😀tail", "a".repeat(58) + "…"],
    ["  \n Keep   this\tline \nignore this", "Keep this line"],
    [" \t\n ", null],
  ])("keeps title boundaries safe for %j", (initialPrompt, expected) => {
    expect(resolveCreateAgentTitles({ initialPrompt }).provisionalTitle).toBe(expected);
  });

  test("does not shorten a supplied manual title when the prompt is overlong", () => {
    const configTitle =
      "A manually chosen title that deliberately exceeds the provisional title limit";
    expect(resolveCreateAgentTitles({ configTitle, initialPrompt: "x".repeat(100) })).toEqual({
      explicitTitle: configTitle,
      provisionalTitle: configTitle,
    });
  });

  test("derives a provisional title from prompt when explicit title is absent", () => {
    const resolved = resolveCreateAgentTitles({
      configTitle: undefined,
      initialPrompt: "Implement auth retries with backoff\n\ninclude tests",
    });

    expect(resolved.explicitTitle).toBeNull();
    expect(resolved.provisionalTitle).toBe("Implement auth retries with backoff");
  });

  test("preserves explicit title and does not treat it as provisional", () => {
    const resolved = resolveCreateAgentTitles({
      configTitle: "  Keep This Title  ",
      initialPrompt: "Ignored prompt title",
    });

    expect(resolved.explicitTitle).toBe("Keep This Title");
    expect(resolved.provisionalTitle).toBe("Keep This Title");
  });

  test("returns null values when prompt and title are empty", () => {
    const resolved = resolveCreateAgentTitles({
      configTitle: "   ",
      initialPrompt: "   ",
    });

    expect(resolved.explicitTitle).toBeNull();
    expect(resolved.provisionalTitle).toBeNull();
  });
});
