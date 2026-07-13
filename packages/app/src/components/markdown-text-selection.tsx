import { createContext, type ReactNode, useContext } from "react";

export type MarkdownTextSurface = "prose" | "table-cell";

const MarkdownTextSurfaceContext = createContext<MarkdownTextSurface>("prose");

export function MarkdownTableCellText({ children }: { children: ReactNode }) {
  return <MarkdownTextSurfaceContext value="table-cell">{children}</MarkdownTextSurfaceContext>;
}

export function useMarkdownTextSurface(): MarkdownTextSurface {
  return useContext(MarkdownTextSurfaceContext);
}

export function iosMarkdownTextIsSelectable(surface: MarkdownTextSurface): boolean {
  return surface !== "table-cell";
}
