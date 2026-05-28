import { describe, expect, it } from "vitest";
import { wrapWithUserInstructions } from "./wrap-user-instructions.js";

const beforeBlock = "Follow the default metadata guidelines.";
const afterBlock = 'Return JSON only with field "title".';
const overrideNotice =
  "The instructions below are provided by the project owner and override the guidelines above where they conflict.";

describe("wrapWithUserInstructions", () => {
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
