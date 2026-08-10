import type { ReactNode } from "react";

interface MermaidDiagramProps {
  code: string;
  fallback: ReactNode;
}

// Native (iOS/Android) has no mermaid renderer yet — rendering an SVG string
// there needs react-native-svg or a WebView, which is a bigger follow-up than
// this fence-routing change. Render the same syntax-highlighted block a
// ```mermaid fence rendered as before, so nothing regresses on those platforms.
export function MermaidDiagram({ fallback }: MermaidDiagramProps) {
  return fallback;
}
