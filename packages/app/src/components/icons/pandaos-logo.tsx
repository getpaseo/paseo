import { useMemo } from "react";
import Svg, { Rect } from "react-native-svg";
import { PANDA_LOGO } from "@/components/panda-frames";
import { buildPandaRuns } from "@/components/panda-sprite";

const COLUMNS = PANDA_LOGO[0]!.length;
const ROWS = PANDA_LOGO.length;

/** The PandaOS mark: the pixel panda's head, in its own colours on any background. */
export function PandaOSLogo({ size = 64 }: { size?: number }) {
  const runs = useMemo(() => buildPandaRuns(PANDA_LOGO), []);
  return (
    <Svg width={(size * COLUMNS) / ROWS} height={size} viewBox={`0 0 ${COLUMNS} ${ROWS}`}>
      {runs.map((run) => (
        <Rect
          key={`${run.x}-${run.y}`}
          x={run.x}
          y={run.y}
          width={run.width}
          height={1}
          fill={run.fill}
        />
      ))}
    </Svg>
  );
}
