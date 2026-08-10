import { useMemo } from "react";
import { Image } from "react-native";
import type { ProjectIconImageProps } from "@/components/project-icon-image";

export function ProjectIconImage({ dataUri, style }: ProjectIconImageProps) {
  const source = useMemo(() => ({ uri: dataUri }), [dataUri]);
  return <Image source={source} style={style} />;
}
