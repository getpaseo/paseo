import { expect, it } from "vitest";
import { createAssistantMarkdownParser } from "@/utils/assistant-markdown-parser";
const corpus = [
  "first words\r\n\r\nsecond words ",
  "visit https://example.com/a%20b and www.example.com then words ",
  "![alt words](image.png) following words ",
  "same same **same same** same ",
  "**bold words** and _italic words_ and ~~strike words~~ ",
  "[same words](https://example.com/same) same words ",
  "`code words` and `` code ` words `` then ",
  "&amp; &#x1f600; café 👨‍👩‍👧‍👦 \\*escaped\\* words ",
  "- first words\n\n- same words\n  - same words\n\nlast words ",
  "| same | same |\n| --- | --- |\n| same | a\\|b |\n",
  "heading words\n=====\n\nparagraph words ",
  "> same words\n> same words\n\nnext words ",
  "before words  \nafter words\n\nfence:\n```ts\nlet x = 1;\n```\n\nafter words ",
];
it.each(corpus)("keeps rendered characters at their source positions: %s", (source) => {
  const parser = createAssistantMarkdownParser({ streaming: true });

  for (let end = 1; end <= source.length; end++) {
    const prefix = source.slice(0, end);
    for (const token of parser.parse(prefix, {}).flatMap((block) => block.children ?? [])) {
      if (!["text", "code_inline"].includes(token.type) || !token.content) continue;
      const offsets: number[] = token.meta.wordSource;
      expect(offsets.length, `${prefix}: ${token.content}`).toBe(token.content.length);
      expect(
        offsets.every((offset) => Number.isInteger(offset) && offset >= 0 && offset < end),
        `${prefix}: ${token.content} ${offsets}`,
      ).toBe(true);
      for (let i = 0; i < token.content.length; i++) {
        if (/\w/u.test(token.content[i]!) && source[offsets[i]!] !== "&")
          expect(source[offsets[i]!], `${prefix}: ${token.content}`).toBe(token.content[i]);
      }
    }
  }
});
