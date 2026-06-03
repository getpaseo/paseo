import { SquareTerminal } from "lucide-react-native";
import { useMemo } from "react";
import { Image, type ImageSourcePropType } from "react-native";
import { isKnownEditorTargetId, type EditorTargetId } from "@/workspace/editor-targets";

interface EditorAppIconProps {
  editorId: EditorTargetId;
  size?: number;
  color?: string;
}

/* eslint-disable @typescript-eslint/no-require-imports */
const EDITOR_APP_IMAGES: Record<string, ImageSourcePropType> = {
  cursor: require("../../../assets/images/editor-apps/cursor.png"),
  vscode: require("../../../assets/images/editor-apps/vscode.png"),
  webstorm: require("../../../assets/images/editor-apps/webstorm.png"),
  zed: require("../../../assets/images/editor-apps/zed.png"),
  finder: require("../../../assets/images/editor-apps/finder.png"),
  explorer: require("../../../assets/images/editor-apps/file-explorer.png"),
  "file-manager": require("../../../assets/images/editor-apps/file-explorer.png"),
};
/* eslint-enable @typescript-eslint/no-require-imports */

export function hasBundledEditorAppIcon(editorId: EditorTargetId): boolean {
  return isKnownEditorTargetId(editorId) && EDITOR_APP_IMAGES[editorId] !== undefined;
}

export function EditorAppIcon({ editorId, size = 16, color }: EditorAppIconProps) {
  const imageStyle = useMemo(() => ({ width: size, height: size }), [size]);
  const source = EDITOR_APP_IMAGES[editorId];
  if (!source) {
    return <SquareTerminal size={size} color={color} />;
  }

  return <Image source={source} style={imageStyle} resizeMode="contain" />;
}
