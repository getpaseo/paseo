import { Folder, SquareTerminal } from "lucide-react-native";
import { useMemo } from "react";
import { Image } from "react-native";

import type { DesktopOpenTargetIcon } from "@/workspace/desktop-open-targets";

interface EditorTargetIconProps {
  icon: DesktopOpenTargetIcon;
  size?: number;
  color?: string;
}

export function EditorTargetIcon({ icon, size = 16, color }: EditorTargetIconProps) {
  const imageStyle = useMemo(() => ({ width: size, height: size }), [size]);
  const imageSource = useMemo(
    () => (icon.kind === "image" ? { uri: icon.dataUrl } : undefined),
    [icon],
  );

  if (imageSource) {
    return <Image source={imageSource} style={imageStyle} resizeMode="contain" />;
  }
  if (icon.kind === "symbol" && icon.name === "folder") {
    return <Folder size={size} color={color} />;
  }
  return <SquareTerminal size={size} color={color} />;
}
