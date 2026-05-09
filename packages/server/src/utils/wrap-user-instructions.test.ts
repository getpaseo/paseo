import { describe, expect, it } from "vitest";
import { wrapWithUserInstructions } from "./wrap-user-instructions.js";

const beforeBlock = "Follow the default metadata guidelines.";
const afterBlock = 'Return JSON only with field "title".';
const outputWithoutUserInstructions = `${beforeBlock}\n\n${afterBlock}`;
const overrideNotice =
  "The instructions below are provided by the project owner and override the guidelines above where they conflict.";

describe("wrapWithUserInstructions", () => {
  it("returns byte-identical output when instructions are undefined", () => {
    expect(wrapWithUserInstructions(beforeBlock, undefined, afterBlock)).toBe(
      outputWithoutUserInstructions,
    );
  });

  it("returns byte-identical output when instructions are null", () => {
    const instructions = null as unknown as string;

    expect(wrapWithUserInstructions(beforeBlock, instructions, afterBlock)).toBe(
      outputWithoutUserInstructions,
    );
  });

  it("returns byte-identical output when instructions are empty", () => {
    expect(wrapWithUserInstructions(beforeBlock, "", afterBlock)).toBe(
      outputWithoutUserInstructions,
    );
  });

  it("returns byte-identical output when instructions are whitespace-only", () => {
    expect(wrapWithUserInstructions(beforeBlock, "   \n\t ", afterBlock)).toBe(
      outputWithoutUserInstructions,
    );
  });

  it("returns byte-identical output when instructions are not a string at runtime", () => {
    const instructions = 42 as unknown as string;

    expect(wrapWithUserInstructions(beforeBlock, instructions, afterBlock)).toBe(
      outputWithoutUserInstructions,
    );
  });

  it("wraps user instructions with the override notice", () => {
    expect(wrapWithUserInstructions(beforeBlock, "Use conventional commits.", afterBlock)).toBe(
      `${beforeBlock}

<user-instructions>
${overrideNotice}

Use conventional commits.
</user-instructions>

${afterBlock}`,
    );
  });

  it("preserves multi-line instructions verbatim inside the block", () => {
    const output = wrapWithUserInstructions(beforeBlock, "line1\nline2", afterBlock);

    expect(output).toContain("line1\nline2");
  });
});
