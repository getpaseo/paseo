import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";

const [, , videoPath, toleranceArg = "4", navBarHeightArg = "0"] = process.argv;

if (!videoPath) {
  throw new Error(
    "Usage: node assert-sheet-footer-keyboard.mjs <screenrecord.mp4> [pixel-tolerance] [nav-bar-height-px]",
  );
}

const tolerance = Number(toleranceArg);
if (!Number.isFinite(tolerance) || tolerance < 0) {
  throw new Error(`Invalid pixel tolerance: ${toleranceArg}`);
}

const navBarHeight = Number(navBarHeightArg);
if (!Number.isFinite(navBarHeight) || navBarHeight < 0) {
  throw new Error(`Invalid navigation bar height: ${navBarHeightArg}`);
}

function probeDimensions(filePath) {
  const output = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=s=x:p=0",
      filePath,
    ],
    { encoding: "utf8" },
  ).trim();
  const [width, height] = output.split("x").map(Number);
  if (!width || !height) {
    throw new Error(`Unable to read video dimensions for ${filePath}: ${output}`);
  }
  return { width, height };
}

function measureButtonBottomPerFrame(filePath, width, height) {
  const centerX = Math.floor(width / 2);
  // Decode only the 1px vertical centerline so full-rate recordings fit comfortably in memory.
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      filePath,
      "-vf",
      `format=rgb24,crop=1:${height}:${centerX}:0`,
      "-vsync",
      "0",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed (${result.status}): ${result.stderr?.toString("utf8") ?? ""}`);
  }

  const buffer = result.stdout;
  const frameSize = height * 3;
  const frameCount = Math.floor(buffer.length / frameSize);
  // Restrict vertical scan below the search field so its green focus ring is excluded.
  const scanTop = Math.floor(height * 0.42);
  const bottoms = [];

  for (let frame = 0; frame < frameCount; frame += 1) {
    const frameOffset = frame * frameSize;
    let maxY = null;
    for (let y = scanTop; y < height; y += 1) {
      const offset = frameOffset + y * 3;
      const r = buffer[offset];
      const g = buffer[offset + 1];
      const b = buffer[offset + 2];
      // Matches the green primary "Open project" button (both enabled and disabled states).
      if (g > 50 && g > r + 15 && g > b + 10) {
        maxY = y;
      }
    }
    bottoms.push(maxY);
  }
  return bottoms;
}

function findSettledValue(values, minRunLength) {
  let runValue = null;
  let runLength = 0;
  for (const value of values) {
    if (value !== null && runValue !== null && Math.abs(value - runValue) <= 2) {
      runLength += 1;
      if (runLength >= minRunLength) return runValue;
    } else {
      runValue = value;
      runLength = value === null ? 0 : 1;
    }
  }
  return null;
}

const { width, height } = probeDimensions(videoPath);
const bottoms = measureButtonBottomPerFrame(videoPath, width, height);
const visibleFrames = bottoms
  .map((bottom, frame) => ({ frame, bottom }))
  .filter((entry) => entry.bottom !== null);

if (visibleFrames.length < 10) {
  throw new Error(
    `Expected at least 10 frames with the Open project footer button visible, found ${visibleFrames.length}`,
  );
}

// Identify settled resting (keyboard closed, lower on screen) and open (keyboard shown, higher on
// screen) positions by finding stable runs separated by at least 200px of keyboard height.
const minBottom = Math.min(...visibleFrames.map((entry) => entry.bottom));
const maxBottom = Math.max(...visibleFrames.map((entry) => entry.bottom));
const midpoint = (minBottom + maxBottom) / 2;

const closedSettled = findSettledValue(
  bottoms.map((y) => (y !== null && y > midpoint ? y : null)),
  15,
);
const openSettled = findSettledValue(
  bottoms.map((y) => (y !== null && y < midpoint ? y : null)),
  15,
);

if (closedSettled === null || openSettled === null || closedSettled - openSettled < 200) {
  throw new Error(
    `Recording did not capture settled keyboard-closed (${closedSettled}) and keyboard-open (${openSettled}) states`,
  );
}

const maxAllowedBottom =
  navBarHeight > 0
    ? Math.min(closedSettled + tolerance, height - navBarHeight)
    : closedSettled + tolerance;
const belowNavViolations = visibleFrames.filter((entry) => entry.bottom > maxAllowedBottom);
const overshootViolations = visibleFrames.filter((entry) => entry.bottom < openSettled - tolerance);

if (belowNavViolations.length > 0 || overshootViolations.length > 0) {
  const summary = [
    `Sheet footer keyboard transition jank detected in ${videoPath}:`,
    `  settled closed bottom=${closedSettled}px (gap=${height - closedSettled}px), settled open bottom=${openSettled}px (gap=${height - openSettled}px), maxAllowedBottom=${maxAllowedBottom}px`,
  ];
  if (belowNavViolations.length > 0) {
    const worst = Math.max(...belowNavViolations.map((entry) => entry.bottom));
    summary.push(
      `  dropped below safe-area clearance on ${belowNavViolations.length} frames (first=f${belowNavViolations[0].frame}, last=f${belowNavViolations.at(-1).frame}, worst bottom=${worst}px, excess=+${worst - maxAllowedBottom}px)`,
    );
  }
  if (overshootViolations.length > 0) {
    const worst = Math.min(...overshootViolations.map((entry) => entry.bottom));
    summary.push(
      `  overshot above open keyboard position on ${overshootViolations.length} frames (first=f${overshootViolations[0].frame}, worst bottom=${worst}px, overshoot=-${openSettled - worst}px)`,
    );
  }
  throw new Error(summary.join("\n"));
}

process.stdout.write(
  `Sheet footer stayed within bounds across ${bottoms.length} frames (${visibleFrames.length} visible): closed=${closedSettled}px, open=${openSettled}px, maxAllowed=${maxAllowedBottom}px, 0 nav-bar overlap frames, 0 overshoot frames\n`,
);
