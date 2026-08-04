import { useCallback, useState, type ReactElement } from "react";
import { View } from "react-native";
import { useIsCompactFormFactor } from "@/constants/layout";
import { ComposerTrackRowLayout, type ComposerTrackRowProps } from "./track-row-layout";

export type { ComposerTrackRowProps };

export function ComposerTrackRow(props: ComposerTrackRowProps): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const showActions = isHovered || isCompact;

  return (
    <View onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      <ComposerTrackRowLayout {...props} isHovered={isHovered} showActions={showActions} />
    </View>
  );
}
