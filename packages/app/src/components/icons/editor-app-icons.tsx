import { SquareTerminal } from "lucide-react-native";
import { Image, type ImageSourcePropType } from "react-native";
import {
  isKnownEditorTargetId,
  type EditorTargetId,
  type KnownEditorTargetId,
} from "@server/shared/messages";

interface EditorAppIconProps {
  editorId: EditorTargetId;
  size?: number;
  color?: string;
}

/* eslint-disable @typescript-eslint/no-require-imports */
const EDITOR_APP_IMAGES: Record<KnownEditorTargetId, ImageSourcePropType> = {
  cursor: require("../../../assets/images/editor-apps/cursor.png"),
  vscode: require("../../../assets/images/editor-apps/vscode.png"),
  webstorm: require("../../../assets/images/editor-apps/webstorm.png"),
  zed: require("../../../assets/images/editor-apps/zed.png"),
  finder: require("../../../assets/images/editor-apps/finder.png"),
  explorer: require("../../../assets/images/editor-apps/file-explorer.png"),
  "file-manager": require("../../../assets/images/editor-apps/file-explorer.png"),
};
/* eslint-enable @typescript-eslint/no-require-imports */

export function hasBundledEditorAppIcon(editorId: EditorTargetId): editorId is KnownEditorTargetId {
  return isKnownEditorTargetId(editorId);
}

export function EditorAppIcon({ editorId, size = 16, color }: EditorAppIconProps) {
  if (!hasBundledEditorAppIcon(editorId)) {
    return <SquareTerminal size={size} color={color} />;
  }

  return (
    <Image
      source={EDITOR_APP_IMAGES[editorId]}
      style={{ width: size, height: size }}
      resizeMode="contain"
    />
  );
}
