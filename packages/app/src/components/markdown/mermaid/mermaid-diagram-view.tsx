import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import {
  buildMermaidThemeKey,
  buildMermaidThemeVariables,
} from "@/components/markdown/mermaid/mermaid-theme";
import {
  MermaidDiagramViewInner,
  type MermaidDiagramViewInnerProps,
} from "@/components/markdown/mermaid/mermaid-diagram-view-inner";

export type MermaidDiagramViewProps = Omit<MermaidDiagramViewInnerProps, "mermaidTheme">;

function mermaidThemeMapping(theme: Theme) {
  const variables = buildMermaidThemeVariables(theme);
  return {
    mermaidTheme: {
      key: buildMermaidThemeKey(variables),
      variables,
    },
  };
}

const ThemedMermaidDiagramView = withUnistyles(MermaidDiagramViewInner);

export function MermaidDiagramView(props: MermaidDiagramViewProps) {
  return <ThemedMermaidDiagramView uniProps={mermaidThemeMapping} {...props} />;
}
