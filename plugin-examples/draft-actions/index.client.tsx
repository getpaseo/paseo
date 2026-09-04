import type { PluginClientContext } from "@getpaseo/plugin";

export default function contribute(client: PluginClientContext) {
  client.addDraftAction({
    id: "tidy-draft",
    title: "Tidy",
    icon: "Brush",
    async transform(text) {
      const tidy = text
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      // Returning the input unchanged leaves the draft (and the caret) untouched.
      return tidy;
    },
  });
  client.addDraftAction({
    id: "checklist",
    title: "Checklist",
    icon: "ListChecks",
    async transform(text) {
      return text
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          return trimmed.startsWith("- ") ? line.replace(/^- /, "- [ ] ") : line;
        })
        .join("\n");
    },
  });
  return () => {};
}
