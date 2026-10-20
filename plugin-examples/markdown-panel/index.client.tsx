import type { PluginClientContext } from "@getpaseo/plugin/client";
import { RichMarkdownPanel } from "./client/rich-markdown";

export default function contribute(client: PluginClientContext) {
  client.addFilePanel({
    id: "rich-markdown",
    title: "Rich Markdown",
    icon: "FileType",
    files: { extensions: ["md", "markdown"] },
    Component: RichMarkdownPanel,
  });
  return () => {};
}
