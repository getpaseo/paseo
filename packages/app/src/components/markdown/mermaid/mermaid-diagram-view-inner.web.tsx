import { useMemo } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { MermaidDiagramHost } from "@/components/markdown/mermaid/mermaid-diagram-host";
import type { MermaidThemeConfig } from "@/components/markdown/mermaid/mermaid-theme-config";
import { useMermaidRender } from "@/components/markdown/mermaid/use-mermaid-render";

export interface MermaidDiagramViewInnerProps {
  source: string;
  mermaidTheme: MermaidThemeConfig;
  onSvgChange?: (svg: string | null) => void;
}

export function MermaidDiagramViewInner({
  source,
  mermaidTheme,
  onSvgChange,
}: MermaidDiagramViewInnerProps) {
  const { t } = useTranslation();
  const { svg, error, isRendering } = useMermaidRender(source, mermaidTheme, onSvgChange);
  const showSpinner = useMemo(() => isRendering && !svg && !error, [error, isRendering, svg]);

  if (error) {
    return (
      <View testID="mermaid-error" style={diagramStyles.errorWrap}>
        <Text style={diagramStyles.errorText}>{t("markdown.mermaid.renderFailed")}</Text>
      </View>
    );
  }

  if (!svg) {
    return (
      <View style={diagramStyles.pendingWrap}>{showSpinner ? <ActivityIndicator /> : null}</View>
    );
  }

  return <MermaidDiagramHost svg={svg} style={diagramStyles.host} />;
}

const diagramStyles = StyleSheet.create((theme) => ({
  host: {
    width: "100%",
  },
  pendingWrap: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[3],
  },
  errorWrap: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
}));
