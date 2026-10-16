import { describe, expect, it } from "vitest";
import { appendQuoteToDraft } from "./composer-quote";

describe("appendQuoteToDraft", () => {
  it("starts an empty draft with the quote and the note under it", () => {
    expect(appendQuoteToDraft({ draft: "", quote: "First line", note: "Why this?" })).toBe(
      "> First line\n\nWhy this?",
    );
  });

  it("quotes every line, blank lines and fences included", () => {
    const quote = "Intro:\n\n```ts\nconst a = 1;\n```";

    expect(appendQuoteToDraft({ draft: "", quote, note: "" })).toBe(
      "> Intro:\n>\n> ```ts\n> const a = 1;\n> ```\n\n",
    );
  });

  it("puts the quote after a blank line below the existing draft", () => {
    expect(
      appendQuoteToDraft({ draft: "> Earlier\n\nFirst note\n\n", quote: "Later", note: "Second" }),
    ).toBe("> Earlier\n\nFirst note\n\n> Later\n\nSecond");
  });

  it("ends on an empty paragraph without a note, so typing does not continue the quote", () => {
    expect(appendQuoteToDraft({ draft: "Hi", quote: "Passage", note: "  \n" })).toBe(
      "Hi\n\n> Passage\n\n",
    );
  });

  it("keeps the line breaks inside the note", () => {
    expect(appendQuoteToDraft({ draft: "", quote: "Passage", note: "One\nTwo" })).toBe(
      "> Passage\n\nOne\nTwo",
    );
  });
});
