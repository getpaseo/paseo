interface RowFrame {
  id: string;
  top: number;
  height: number;
}
export interface ScrollFrame {
  at: number;
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  virtualized: boolean;
  loading: boolean;
  rows: RowFrame[];
  anchor: string | null;
  wheelTotal: number;
  lastWheelAt: number;
  inputFinishedAt: number | null;
  imageLoads: number;
  mounted: number;
  unmounted: number;
}

export function findScrollJumps(frames: ScrollFrame[]) {
  return frames.flatMap((current, index) => {
    const previous = frames[index - 1];
    if (!previous?.anchor) return [];
    // Wheel input can move the reading line onto an image before it expands.
    // Follow that intended row, not text now below the image.
    const recent = frames.findLast((frame) => frame.at <= previous.at - 100);
    const wheelBudget = current.wheelTotal - (recent?.wheelTotal ?? 0);
    const currentRows = new Map(current.rows.map((row) => [row.id, row]));
    const anchor = previous.anchor;
    const before = currentRows.has(anchor)
      ? previous.rows.find((row) => row.id === anchor)!
      : previous.rows
          .filter((row) => currentRows.has(row.id))
          .sort((left, right) => Math.abs(left.top - 8) - Math.abs(right.top - 8))[0];
    if (!before) {
      throw new Error(`No shared reading geometry between frames ${index - 1} and ${index}`);
    }
    const after = currentRows.get(before.id)!;
    const movement = after.top - before.top;
    // A busy main thread can deliver wheel movement hundreds of milliseconds
    // after its event. Only assert idle stability after the driver stops input.
    const idle = current.inputFinishedAt !== null && previous.at - current.inputFinishedAt > 250;
    // scrollTop also includes virtualizer estimate corrections. Locate the row
    // entered by wheel input from its viewport movement instead. Its old height
    // identifies the reader before a simultaneous image resize takes effect.
    const intendedRow = previous.rows.find((row) => {
      const next = currentRows.get(row.id);
      if (!next || idle || wheelBudget <= 0) return false;
      const travel = next.top - row.top;
      return (
        travel >= -8 &&
        travel <= Math.min(wheelBudget, previous.scrollTop) + 32 &&
        (next.top <= 8 || current.scrollTop === 0) &&
        next.top + row.height > 8
      );
    });
    const enteredRowResize = intendedRow
      ? previous.rows.reduce((growth, row) => {
          if (row.top < intendedRow.top || row.top >= before.top) return growth;
          const height = currentRows.get(row.id)?.height ?? row.height;
          return growth + height - row.height;
        }, 0)
      : 0;
    const readingMovement = movement - enteredRowResize;
    const excessForward = readingMovement > wheelBudget + 32;
    // Upward wheel input moves the same text DOWN the viewport. A negative move
    // is a reversal, independent of legitimate scrollTop compensation on prepend.
    if (readingMovement >= -8 && (!idle || Math.abs(readingMovement) <= 8) && !excessForward)
      return [];
    return [
      {
        frame: index,
        at: current.at,
        row: before.id,
        movement,
        idle,
        excessForward,
        resizedRows: current.rows.flatMap((row) => {
          const old = previous.rows.find((candidate) => candidate.id === row.id);
          return old && old.height !== row.height
            ? [{ id: row.id, before: old.height, after: row.height }]
            : [];
        }),
        loading: current.loading || previous.loading,
        virtualized: current.virtualized,
        heightChange: current.scrollHeight - previous.scrollHeight,
        imageLoads: current.imageLoads - previous.imageLoads,
        frameGapMs: current.at - previous.at,
      },
    ];
  });
}
