import { describe, expect, it } from "vitest";
import {
  countProviderImages,
  isProviderImageMarkdown,
  isProviderImageOnlyMarkdown,
} from "./provider-image.js";

const HASH = "a".repeat(64);
const IMAGE = `![Image](file:///tmp/paseo-attachments-test/${HASH}.png)`;

describe("provider image markdown", () => {
  it.each([
    `/tmp/paseo-attachments/${HASH}.png`,
    `/tmp/paseo-attachments-test/${HASH}.webp`,
    `/tmp/paseo-attachments/user-1000/${HASH}.jpg`,
    `file:///C:/Users/test/AppData/Local/Temp/paseo-attachments-test/${HASH}.png`,
    `C:\\\\Temp\\\\paseo-attachments\\\\${HASH}.png`,
  ])("recognizes a complete materialized image at %s", (source) => {
    const markdown = `\n\n![Image](${source})\n\n`;
    expect(isProviderImageMarkdown(markdown)).toBe(true);
    expect(isProviderImageOnlyMarkdown(markdown)).toBe(true);
    expect(countProviderImages(markdown)).toBe(1);
  });

  it("recognizes adjacent image outputs merged into one message", () => {
    expect(isProviderImageOnlyMarkdown(`\n\n${IMAGE}\n\n${IMAGE}\n\n`)).toBe(true);
    expect(countProviderImages(`\n\n${IMAGE}\n\n${IMAGE}\n\n`)).toBe(2);
    expect(countProviderImages(IMAGE.repeat(11))).toBe(11);
    expect(countProviderImages(IMAGE)).toBe(1);
  });

  it("preserves the history prefix check without hiding following prose", () => {
    const message = `${IMAGE}\n\nHere is the explanation.`;
    expect(isProviderImageMarkdown(message)).toBe(true);
    expect(isProviderImageOnlyMarkdown(message)).toBe(false);
  });

  it.each([
    "",
    " \n\n ",
    "![Image](https://example.com/image.png)",
    "![Image](/tmp/paseo-attachments/notes.png)",
    `Before\n\n${IMAGE}`,
    `${IMAGE}\n\nBetween\n\n${IMAGE}`,
    `${IMAGE}\n\n![Other](/repo/image.png)`,
    `\`\`\`markdown\n${IMAGE}\n\`\`\``,
  ])("does not classify ordinary or mixed content as image-only: %j", (text) => {
    expect(isProviderImageOnlyMarkdown(text)).toBe(false);
    expect(countProviderImages(text)).toBe(0);
  });
});
