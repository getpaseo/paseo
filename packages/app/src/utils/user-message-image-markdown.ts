const USER_IMAGE_MARKDOWN = /!\[(?:\\\]|[^\]])*\]\((file:\/\/[^)\s]+|\/[^)\s]+)\)/g;

export function splitUserMessageImageMarkdown(text: string): {
  visibleText: string;
  imageSources: string[];
} {
  const imageSources: string[] = [];
  const visibleText = text
    .replace(USER_IMAGE_MARKDOWN, (_match, source: string) => {
      imageSources.push(source);
      return "\n";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return { visibleText, imageSources };
}
