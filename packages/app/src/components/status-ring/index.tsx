import { memo } from "react";
import { useReducedMotion } from "react-native-reanimated";
import {
  StatusRingFrame,
  StatusRingInk,
  type StatusRingProps,
} from "@/components/status-ring/frame";
import { STATUS_RING_FRAME_SIZE } from "@/components/status-ring/geometry";
import { StatusPulse } from "@/components/status-ring/motion";

/**
 * The running indicator: a status dot with a quarter turning around it, breathing from the running
 * colour to the success colour and back. With reduced motion it holds the running colour at its
 * resting size, and only the quarter turns.
 *
 * Each platform drives the motion from one shared timeline, so a ring that mounts mid-flight is
 * already in phase with the rest — see `motion.tsx` and `motion.web.tsx`.
 */
export const StatusRing = memo(function StatusRing({ backdrop }: StatusRingProps) {
  const reduceMotion = useReducedMotion();

  return (
    <StatusPulse size={STATUS_RING_FRAME_SIZE} reduceMotion={reduceMotion}>
      <StatusRingFrame backdrop={backdrop}>
        <StatusRingInk tone="running" />
      </StatusRingFrame>
      <StatusRingInk tone="success" />
    </StatusPulse>
  );
});
