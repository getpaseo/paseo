import { useEffect, useMemo } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { MermaidDiagramHost } from "@/components/markdown/mermaid/mermaid-diagram-host";
import { useMermaidRender } from "@/components/markdown/mermaid/use-mermaid-render";

interface MermaidDiagramViewProps {
  source: string;
  onSvgChange?: (svg: string | null) => void;
}

export function MermaidDiagramView({ source, onSvgChange }: MermaidDiagramViewProps) {
  const { t } = useTranslation();
  const { svg, error, isRendering } = useMermaidRender(source);
  const showSpinner = useMemo(() => isRendering && !svg && !error, [error, isRendering, svg]);

  useEffect(() => {
    onSvgChange?.(svg);
  }, [onSvgChange, svg]);

  if (error) {
    return (
      <View style={diagramStyles.errorWrap}>
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
