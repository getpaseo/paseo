import type { ComponentType } from "react";
import { SvgXml } from "react-native-svg";
import { getFileIconSvg } from "@/components/material-file-icons";
import type { PanelIconProps } from "@/panels/panel-registry";

export function MaterialFileIcon({ fileName, size }: { fileName: string; size: number }) {
  return <SvgXml xml={getFileIconSvg(fileName)} width={size} height={size} />;
}

export function createMaterialFileIcon(fileName: string): ComponentType<PanelIconProps> {
  function BoundMaterialFileIcon({ size }: PanelIconProps) {
    return <MaterialFileIcon fileName={fileName} size={size} />;
  }
  return BoundMaterialFileIcon;
}
