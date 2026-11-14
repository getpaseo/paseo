// Record a sidebar toast through timeout on the 2560×1600 Android tablet.
// Pass a vertical sample line through the card's plain interior, away from text,
// icons, and Android's clipboard preview, plus the visible-to-dismissed interval:
// node .../toast-dismissal.mjs recording.mp4 sample-x start-seconds end-seconds
// This checks actual native frames; a browser layout test misses this regression.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const [, , recording, sampleX, start, end] = process.argv;
assert(recording && sampleX && start && end, "Pass recording, sample x, start and end seconds");
const { frames } = JSON.parse(
  execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v",
      "-show_entries",
      "frame=best_effort_timestamp_time",
      "-of",
      "json",
      recording,
    ],
    { encoding: "utf8" },
  ),
);
const selectedFrames = frames
  .map((frame, index) => ({ time: Number(frame.best_effort_timestamp_time), index }))
  .filter(({ time }) => time >= Number(start) && time <= Number(end));
assert(selectedFrames.length > 2, "Capture at least three frames in the supplied interval");
const firstFrame = selectedFrames[0].index;
const endFrame = selectedFrames.at(-1).index + 1;
const bytesPerFrame = 800;
// Bound both output and buffer to the requested frames, even for a long recording.
const pixels = execFileSync(
  "ffmpeg",
  [
    "-v",
    "fatal",
    "-i",
    recording,
    "-vf",
    `trim=start_frame=${firstFrame}:end_frame=${endFrame},crop=2:400:${Number(sampleX)}:1100,format=gray`,
    "-fps_mode",
    "passthrough",
    "-f",
    "rawvideo",
    "-",
  ],
  { maxBuffer: selectedFrames.length * bytesPerFrame + 1024 },
);
assert.equal(
  pixels.length,
  selectedFrames.length * bytesPerFrame,
  "Every selected frame must be decoded",
);
const positions = [];
let disappeared = false;
for (const [index, { time }] of selectedFrames.entries()) {
  const column = pixels.subarray(index * bytesPerFrame, (index + 1) * bytesPerFrame);
  const runs = [];
  let run = [];
  for (let y = 0; y < 400; y++) {
    if (column[y * 2] > 250) run.push(y);
    else {
      if (run.length > 40) runs.push(run);
      run = [];
    }
  }
  if (run.length > 40) runs.push(run);
  runs.sort((a, b) => b.length - a.length);
  if (runs.length) {
    const card = runs[0];
    positions.push({ time, centre: 1100 + (card[0] + card.at(-1)) / 2 });
  } else if (positions.length) disappeared = true;
}
assert(positions.length > 2, "Capture at least three visible card frames");
assert(disappeared, "Recording must include the card disappearing");
const centres = positions.map(({ centre }) => centre);
const shift = Math.max(...centres) - Math.min(...centres);
console.log(JSON.stringify({ positions, maximumShiftPixels: shift }, null, 2));
assert(shift <= 2, `Toast moved ${shift}px during dismissal`);
