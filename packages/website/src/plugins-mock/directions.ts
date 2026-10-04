import type { Direction } from "./data";
import { directionA } from "./direction-a";
import { directionB } from "./direction-b";
import { directionC } from "./direction-c";
import { directionD } from "./direction-d";
import type { DirectionComponents } from "./shared";

export const DIRECTIONS: Record<Direction, DirectionComponents> = {
  a: directionA,
  b: directionB,
  c: directionC,
  d: directionD,
};
