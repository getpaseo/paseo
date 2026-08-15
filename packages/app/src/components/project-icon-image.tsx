import { Buffer } from "buffer";
import { type ReactElement, useMemo } from "react";
import { Image, type ImageStyle, type StyleProp, View } from "react-native";
import { SvgCss } from "react-native-svg/css";

const SVG_MIME_TYPE = "image/svg+xml";
const ICO_MIME_TYPES = new Set(["image/x-icon", "image/vnd.microsoft.icon"]);
const SVG_CONTAINER = { overflow: "hidden" } as const;

export interface ProjectIconImageProps {
  dataUri: string;
  fallback: ReactElement;
  style: StyleProp<ImageStyle>;
}

function parseDataUri(dataUri: string): { mimeType: string; payload: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUri);
  if (!match) return null;

  const [, mimeType, payload] = match;
  return mimeType && payload ? { mimeType: mimeType.toLowerCase(), payload } : null;
}

function ignoreSvgParseError() {
  // Invalid repository SVGs use the same fallback as unsupported icon formats.
}

export function ProjectIconImage({ dataUri, fallback, style }: ProjectIconImageProps) {
  const source = useMemo(() => ({ uri: dataUri }), [dataUri]);
  const parts = useMemo(() => parseDataUri(dataUri), [dataUri]);
  const svgXml = useMemo(
    () =>
      parts?.mimeType === SVG_MIME_TYPE
        ? Buffer.from(parts.payload, "base64").toString("utf8")
        : null,
    [parts],
  );
  const svgContainerStyle = useMemo(() => [style, SVG_CONTAINER], [style]);

  if (svgXml) {
    return (
      <View style={svgContainerStyle}>
        <SvgCss
          xml={svgXml}
          width="100%"
          height="100%"
          fallback={fallback}
          onError={ignoreSvgParseError}
        />
      </View>
    );
  }
  if (parts && ICO_MIME_TYPES.has(parts.mimeType)) return fallback;
  return <Image source={source} style={style} />;
}
