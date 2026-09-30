import { PandaStatus } from "@/components/panda-status";
import type { PandaMood } from "./inbox-model";

const LARGE_GRID = 32;

/** The Leitstand's status panda: its pose says at a glance whether anything needs you. */
export function LeitstandPanda({ mood, size }: { mood: PandaMood; size: number }) {
  return (
    <PandaStatus mood={mood} size="large" pixelScale={Math.max(1, Math.round(size / LARGE_GRID))} />
  );
}
