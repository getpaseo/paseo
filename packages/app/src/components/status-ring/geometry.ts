import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";

// The running indicator is a status dot with a rotating ring around it, and the whole set of
// numbers below is a budget rather than four independent choices. The centre matches every other
// filled status circle; the gap and stroke grow outward from it without changing that shared size.
export const STATUS_RING_GAP = 1.5;
export const STATUS_RING_STROKE = 1.5;
// Derived outward from the dot, which means the dot is not a free variable: shrink it without
// opening the gap by the same amount and the ring closes in behind it, the whole mark scales
// down, and nothing about how the centre reads against the ring actually changes.
export const STATUS_RING_SIZE =
  STATUS_INDICATOR_FILLED_DOT_SIZE + (STATUS_RING_GAP + STATUS_RING_STROKE) * 2;

// The knockout margin, and the reason the frame is wider than the ring. These indicators sit on
// the bottom-right corner of an agent or project icon, and a dot only stays readable there
// because it carries a ring of surface colour separating it from the art underneath. A ring drawn
// out to the frame's edge has no such separation and collides with the icon, so the frame is the
// knockout and the ring lives inside it.
export const STATUS_RING_HALO_INSET = 1;
export const STATUS_RING_FRAME_SIZE = STATUS_RING_SIZE + STATUS_RING_HALO_INSET * 2;

// The track and the quarter riding it are the same color and differ only here. The track is low
// enough that the quarter is unmistakably the thing moving, high enough that the ring still reads
// as a ring when the quarter is on the far side of it. The quarter is held off full so the centre
// dot stays the solid part of the mark — the ring is what the dot is doing, not a second dot.
export const STATUS_RING_TRACK_OPACITY = 0.3;
export const STATUS_RING_HEAD_OPACITY = 0.9;

// One period for every ring in the app. Each platform owns one mount-independent timeline: web
// animations share an absolute document-timeline start, while native publishes this wall-clock
// phase from one UI-thread clock. A row that appears mid-flight therefore lands in step with the
// rings already turning.
export const STATUS_RING_PERIOD_MS = 900;

export function getStatusRingRotation(nowMs: number): number {
  "worklet";
  return ((nowMs % STATUS_RING_PERIOD_MS) / STATUS_RING_PERIOD_MS) * 360;
}

// The running mark also breathes: it swells and shifts from the running colour to the success
// colour and back. One breath is a whole number of turns, so every peak lands on the same arc
// position and the two motions read as one rhythm rather than drifting against each other. Three
// turns keeps it slow enough to read as calm next to a ring that is already moving.
export const STATUS_PULSE_PERIOD_MS = STATUS_RING_PERIOD_MS * 3;

// Applied to the whole knockout frame, so the halo grows with the ring and the mark never closes
// in on the icon it sits on. Transform only: the slot, the hit target and the layout stay put.
export const STATUS_PULSE_PEAK_SCALE = 1.12;

/**
 * How far into the breath the mark is: 0 is the running colour at resting size, 1 the success
 * colour at peak size. A raised cosine, so it eases at both ends instead of bouncing off them.
 * Wall-clock based for the same reason as the rotation: marks mounted at different moments agree.
 */
export function getStatusPulseProgress(nowMs: number): number {
  "worklet";
  const phase = (nowMs % STATUS_PULSE_PERIOD_MS) / STATUS_PULSE_PERIOD_MS;
  return (1 - Math.cos(phase * 2 * Math.PI)) / 2;
}

export function getStatusPulseScale(progress: number): number {
  "worklet";
  return 1 + (STATUS_PULSE_PEAK_SCALE - 1) * progress;
}

/**
 * Re-anchors a corner status dot's offset for the ring that replaces it.
 *
 * The dots this replaces are pinned to an icon's bottom-right corner rather than centred in a
 * slot, so growing them in place would walk the indicator off the corner. Callers keep their
 * existing dot offset and pass it through here to grow around the same centre point.
 */
export function getStatusRingOffset(dotOffset: number, dotSize: number): number {
  return dotOffset - (STATUS_RING_FRAME_SIZE - dotSize) / 2;
}
