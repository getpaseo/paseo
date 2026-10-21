import { type PluginFilePanelProps, useFileUrl } from "@getpaseo/plugin/client";
import { DocumentFrame, Loading } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Text, View } from "react-native";

const messageStyle = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
} as const;

export function PdfPanel({ file, theme }: PluginFilePanelProps) {
  const url = useFileUrl(file);
  const textStyle = useMemo(() => ({ color: theme.colors.statusDanger }), [theme]);
  if (url.status === "loading") return <Loading />;
  if (url.status === "error") {
    return (
      <View style={messageStyle}>
        <Text style={textStyle}>{url.error.message}</Text>
      </View>
    );
  }
  return <DocumentFrame url={url.url} testID="pdf-panel" />;
}
