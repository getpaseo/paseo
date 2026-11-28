import { useMemo } from "react";
import { PointerArrow } from "./icons";
import { useSceneClock } from "./player";
import type { PointerClick } from "./script";
import type { MockupStateId } from "./states";

/**
 * The visitor's stand-in: a mouse pointer that glides to a spot and clicks it. The spot is where
 * `className` places the pointer in its nearest positioned ancestor.
 */
export function Pointer({
  scene,
  click,
  from,
  className,
}: {
  scene: MockupStateId;
  click: PointerClick;
  /** Where the pointer sets off from, in design pixels from the spot it clicks. */
  from: { x: number; y: number };
  className: string;
}) {
  const opacity = useSceneClock(scene, click.opacity);
  const approach = useSceneClock(scene, click.approach);
  const pressed = useSceneClock(scene, click.pressed);
  const style = useMemo(
    () => ({
      opacity,
      transform: `translate(${(1 - approach) * from.x}px, ${(1 - approach) * from.y}px)`,
    }),
    [opacity, approach, from],
  );
  if (opacity === 0) return null;
  return (
    <span
      // The arrow's tip is the glyph's top left corner, so that corner is what lands on the spot.
      className={`pointer-events-none absolute z-10 ${className}`}
      style={style}
    >
      <PointerArrow
        className={`origin-top-left transition-[scale] duration-100 ${pressed ? "scale-[0.86]" : ""}`}
      />
    </span>
  );
}
