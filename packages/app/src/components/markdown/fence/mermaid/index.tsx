import type { MarkdownFenceRendererProps } from "../types";
import { MermaidFenceHost } from "./host";

export function MermaidFence(props: MarkdownFenceRendererProps) {
  return <MermaidFenceHost {...props} />;
}
