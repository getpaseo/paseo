import { describe, expect, it } from "vitest";
import { parseResponseFooter, responseDisplayText } from "./footer.js";

describe("response footer", () => {
  it("extracts a final summary and preserves the response", () => {
    expect(
      parseResponseFooter(
        'Done.\n<paseo-meta message="Fixed &amp; tested &quot;tabs&quot;." title="Tab names" icon="🎛️" />',
      ),
    ).toEqual({
      text: "Done.",
      metadata: { message: 'Fixed & tested "tabs".', title: "Tab names", icon: "🎛️" },
    });
  });
});

it("keeps omitted names and accepts future attributes", () => {
  expect(parseResponseFooter('<paseo-meta message="Ready." future="ok" />')?.metadata).toEqual({
    message: "Ready.",
  });
});
it.each([
  '```xml\n<paseo-meta message="Example." />\n```',
  '```\n<paseo-meta message="Example." />',
  '    <paseo-meta message="Example." />',
  'Example: <paseo-meta message="Example." />',
  '<paseo-meta message="First." message="Second." />',
  '<paseo-meta message="Bad &entity;" />',
  '<paseo-meta title="No summary" />',
  '<paseo-meta message="Ready." />\nMore text',
  `<paseo-meta message="${"a".repeat(4096)}" />`,
])("does not consume ordinary or malformed text: %s", (text) => {
  expect(parseResponseFooter(text)).toBeNull();
  expect(responseDisplayText(text)).toBe(text);
});
it.each([
  '\n<paseo-meta message="Fixed &amp; tested." title="Fix" icon="✅" />',
  '\n<paseo-meta message="Checked &quot;quotes&quot; and &lt;tags&gt;." />',
  "\n<paseo-meta message='Checked &apos;quotes&apos;.' icon='🧑‍💻' />",
])("withholds the footer across every streaming boundary: %s", (footer) => {
  const body = "Completed.";
  for (let i = 2; i <= footer.length; i++) {
    expect(responseDisplayText(body + footer.slice(0, i), true)).toBe(body);
  }
});
it("decodes escaped angle brackets and apostrophes without reparsing them", () => {
  expect(
    parseResponseFooter(
      '<paseo-meta message="Checked &lt;tag&gt;, &apos;quotes&apos;, &amp;quot;." />',
    )?.metadata.message,
  ).toBe("Checked <tag>, 'quotes', &quot;.");
});
it("releases incomplete text when streaming ends and invalid text immediately", () => {
  expect(responseDisplayText('Answer.\n<paseo-meta message="', false)).toBe(
    'Answer.\n<paseo-meta message="',
  );
  expect(responseDisplayText("Answer.\n<ordinary>", true)).toBe("Answer.\n<ordinary>");
  expect(responseDisplayText("Answer.\n<paseo-meta bad />", true)).toBe(
    "Answer.\n<paseo-meta bad />",
  );
});
it("accepts closed fences before the footer and numeric entities", () => {
  expect(
    parseResponseFooter('```\ncode\n```\n<paseo-meta message="Done &#x26; checked." />')?.metadata
      .message,
  ).toBe("Done & checked.");
});
it("releases a malformed prefix before the stream ends", () => {
  const text = "Answer.\n<paseo-meta message!!!";
  expect(responseDisplayText(text, true)).toBe(text);
});
describe("recommended prompts", () => {
  it("collects prompt1 to prompt3 in order and skips blanks", () => {
    expect(
      parseResponseFooter(
        '<paseo-meta message="Done." prompt3="Ship it" prompt1="Run the tests" prompt2="   " />',
      )?.metadata,
    ).toEqual({ message: "Done.", prompts: ["Run the tests", "Ship it"] });
  });
  it("omits prompts when none are given", () => {
    expect(parseResponseFooter('<paseo-meta message="Done." />')?.metadata).toEqual({
      message: "Done.",
    });
  });
  it("decodes entities inside prompts", () => {
    expect(
      parseResponseFooter('<paseo-meta message="Done." prompt1="Fix &quot;a&quot; &amp; b" />')
        ?.metadata.prompts,
    ).toEqual(['Fix "a" & b']);
  });
});
