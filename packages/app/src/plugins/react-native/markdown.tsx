import type { MarkdownProps } from "@getpaseo/plugin/client/ui";
import { MarkdownRenderer } from "@/components/markdown/renderer";

export function Markdown({ children, math }: MarkdownProps) {
  return children ? <MarkdownRenderer text={children} math={math} /> : null;
}
