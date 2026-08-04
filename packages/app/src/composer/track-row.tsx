import type { ReactElement } from "react";
import { ComposerTrackRowLayout, type ComposerTrackRowProps } from "./track-row-layout";

export type { ComposerTrackRowProps };

export function ComposerTrackRow(props: ComposerTrackRowProps): ReactElement {
  return <ComposerTrackRowLayout {...props} isHovered={false} showActions />;
}
