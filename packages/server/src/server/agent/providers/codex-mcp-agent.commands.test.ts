import { describe, test, expect } from "vitest";

import { __test__ } from "./codex-mcp-agent.js";

describe("codex custom command plumbing", () => {
  test("parseFrontMatter extracts metadata and body", () => {
    const input = [
      "---",
      "description: Hello",
      "argument-hint: NAME=<name>",
      "---",
      "",
      "Say hi to $NAME",
      "",
    ].join("\n");

    const parsed = __test__.parseFrontMatter(input);
    expect(parsed.frontMatter["description"]).toBe("Hello");
    expect(parsed.frontMatter["argument-hint"]).toBe("NAME=<name>");
    expect(parsed.body).toContain("Say hi to $NAME");
  });

  test("expandCodexCustomPrompt supports named + positional placeholders", () => {
    const template = "A=$A B=$B 1=$1 2=$2 ARGS=$ARGUMENTS $$=$$";
    const out = __test__.expandCodexCustomPrompt(template, "A=hello B=world one two");
    expect(out).toContain("A=hello");
    expect(out).toContain("B=world");
    expect(out).toContain("1=one");
    expect(out).toContain("2=two");
    expect(out).toContain("ARGS=A=hello B=world one two");
    expect(out).toContain("$=$");
  });

  test("tokenizeCommandArgs respects quotes", () => {
    const tokens = __test__.tokenizeCommandArgs('A=\"hello world\" B=two three');
    expect(tokens).toEqual(["A=hello world", "B=two", "three"]);
  });
});
