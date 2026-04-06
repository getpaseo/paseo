import { Image, type ImageSourcePropType } from "react-native";
import type { EditorTargetId } from "@server/shared/messages";

interface EditorAppIconProps {
  editorId: EditorTargetId;
  size?: number;
  color?: string;
}

/* eslint-disable @typescript-eslint/no-require-imports */
const EDITOR_APP_IMAGES: Record<EditorTargetId, ImageSourcePropType> = {
  cursor: require("../../../assets/images/editor-apps/cursor.png"),
  vscode: require("../../../assets/images/editor-apps/vscode.png"),
  zed: require("../../../assets/images/editor-apps/zed.png"),
  finder: require("../../../assets/images/editor-apps/finder.png"),
  explorer: require("../../../assets/images/editor-apps/file-explorer.png"),
  "file-manager": require("../../../assets/images/editor-apps/file-explorer.png"),
};
/* eslint-enable @typescript-eslint/no-require-imports */

export function EditorAppIcon({
  editorId,
  size = 16,
}: EditorAppIconProps) {
  return (
    <Image
      source={EDITOR_APP_IMAGES[editorId]}
      style={{ width: size, height: size }}
      resizeMode="contain"
    />
  );
}
