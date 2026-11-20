import type { MarkdownProps } from "@getpaseo/plugin/client/ui";
import { MarkdownRenderer } from "@/components/markdown/renderer";

export function Markdown({ children }: MarkdownProps) {
  return children ? <MarkdownRenderer text={children} /> : null;
}
