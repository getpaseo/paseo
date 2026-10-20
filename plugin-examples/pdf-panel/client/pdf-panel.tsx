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

export function PdfPanel(props: PluginFilePanelProps) {
  if (props.layout.platform === "android") return <AndroidPdf {...props} />;
  return <InlinePdf {...props} />;
}

function InlinePdf({ file, theme }: PluginFilePanelProps) {
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

function AndroidPdf({ file, theme }: PluginFilePanelProps) {
  const textStyle = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  return (
    <View style={messageStyle}>
      <Text style={textStyle}>
        {file.name} ({Math.round(file.size / 1024)} KB). Android cannot render PDF inline.
      </Text>
    </View>
  );
}
