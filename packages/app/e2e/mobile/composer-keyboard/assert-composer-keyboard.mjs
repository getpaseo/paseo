import fs from "node:fs/promises";
import process from "node:process";
import sharp from "sharp";

const [, , command, ...args] = process.argv;

if (command === "xml-composer-contained") {
  const [snapshotPath, imeTopArgument, densityArgument] = args;
  const snapshot = await fs.readFile(snapshotPath, "utf8");
  const boundsFor = (id) => {
    const node = snapshot.match(new RegExp(`<node[^>]*resource-id="${id}"[^>]*>`));
    if (!node) throw new Error(`Missing node: ${id}`);
    const bounds = node[0].match(/bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/);
    if (!bounds) throw new Error(`Missing bounds: ${id}`);
    return { top: Number(bounds[2]), bottom: Number(bounds[4]) };
  };
  const viewport = boundsFor("composer-viewport");
  const content = boundsFor("composer-viewport-content");
  const composer = boundsFor("message-input-root");
  const controls = boundsFor("message-input-attach-button");
  const clearance = (5 * Number(densityArgument)) / 160;
  const minimumTop = viewport.top + clearance;
  // Android rounds layout units to physical pixels; allow one pixel of rounding.
  if (content.top < minimumTop - 1 || composer.top < minimumTop - 1) {
    throw new Error(
      `Composer overlaps header: content=${content.top}, editor=${composer.top}, minimum=${minimumTop}`,
    );
  }
  if (composer.bottom > Number(imeTopArgument) || controls.bottom > Number(imeTopArgument)) {
    throw new Error(
      `Composer extends behind keyboard: editor=${composer.bottom}, controls=${controls.bottom}, keyboard=${imeTopArgument}`,
    );
  }
  process.stdout.write(
    `Composer contained: top=${composer.top}, header=${viewport.top}, bottom=${composer.bottom}, keyboard=${imeTopArgument}\n`,
  );
} else if (command === "rect") {
  const [snapshotPath, identifier] = args;
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  const node = snapshot.data.nodes.find(
    (candidate) =>
      candidate.identifier === identifier ||
      candidate.label === identifier ||
      (identifier === "editable" && candidate.type.endsWith("EditText")),
  );
  if (!node) throw new Error(`Missing node: ${identifier}`);
  const { x, y, width, height } = node.rect;
  process.stdout.write(`${Math.round(x + width / 2)} ${Math.round(y + height / 2)} ${height}\n`);
} else if (command === "above-y") {
  const [snapshotPath, upperIdentifier, lowerYArgument] = args;
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  const upper = snapshot.data.nodes.find(
    (candidate) => candidate.identifier === upperIdentifier || candidate.label === upperIdentifier,
  );
  if (!upper) throw new Error(`Missing node: ${upperIdentifier}`);
  const upperBottom = upper.rect.y + upper.rect.height;
  const lowerY = Number(lowerYArgument);
  if (upperBottom > lowerY) {
    throw new Error(
      `${upperIdentifier} extends below the composer top: ${upperBottom} > ${lowerY}`,
    );
  }
} else if (command === "xml-above-y") {
  const [snapshotPath, contentDescription, lowerYArgument] = args;
  const snapshot = await fs.readFile(snapshotPath, "utf8");
  const escapedDescription = contentDescription.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = snapshot.match(
    new RegExp(
      `<node[^>]*content-desc="${escapedDescription}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
    ),
  );
  if (!match) throw new Error(`Missing node: ${contentDescription}`);
  const upperBottom = Number(match[4]);
  const lowerY = Number(lowerYArgument);
  if (upperBottom > lowerY) {
    throw new Error(`${contentDescription} extends below the keyboard: ${upperBottom} > ${lowerY}`);
  }
} else if (command === "same-header") {
  const [baselinePath, keyboardPath, headerBottomArgument] = args;
  const headerBottom = Number(headerBottomArgument);
  const crop = { left: 0, top: 64, width: 1080, height: headerBottom - 64 };
  const [baseline, keyboard] = await Promise.all([
    sharp(baselinePath).extract(crop).removeAlpha().raw().toBuffer(),
    sharp(keyboardPath).extract(crop).removeAlpha().raw().toBuffer(),
  ]);
  let changed = 0;
  for (let index = 0; index < baseline.length; index += 1) {
    if (Math.abs(baseline[index] - keyboard[index]) > 8) changed += 1;
  }
  const changedRatio = changed / baseline.length;
  if (changedRatio > 0.01) {
    throw new Error(`Header changed while the keyboard opened (${changedRatio.toFixed(3)})`);
  }
} else if (command === "same-input-height") {
  const [firstPath, secondPath] = args;
  const readInputHeight = async (snapshotPath) => {
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
    const input = snapshot.data.nodes.find((candidate) => candidate.type.endsWith("EditText"));
    if (!input) throw new Error(`Missing composer input in ${snapshotPath}`);
    return input.rect.height;
  };
  const [firstHeight, secondHeight] = await Promise.all([
    readInputHeight(firstPath),
    readInputHeight(secondPath),
  ]);
  // Yoga rounds each edge to physical pixels; moving the same-sized input can
  // change its reported height by one pixel when its origin is fractional.
  if (Math.abs(firstHeight - secondHeight) > 1) {
    throw new Error(`Composer height drifted from ${firstHeight} to ${secondHeight}`);
  }
} else if (command === "has-exact-text") {
  const [snapshotPath, expected] = args;
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  if (!snapshot.data.nodes.some((candidate) => candidate.label === expected)) {
    throw new Error(`Missing exact text in ${snapshotPath}: ${expected}`);
  }
} else if (command === "same-region") {
  const [firstPath, secondPath, topArgument, heightArgument, failureMessage] = args;
  const crop = {
    left: 0,
    top: Number(topArgument),
    width: 1080,
    height: Number(heightArgument),
  };
  const [first, second] = await Promise.all([
    sharp(firstPath).extract(crop).removeAlpha().raw().toBuffer(),
    sharp(secondPath).extract(crop).removeAlpha().raw().toBuffer(),
  ]);
  let changed = 0;
  for (let index = 0; index < first.length; index += 1) {
    if (Math.abs(first[index] - second[index]) > 8) changed += 1;
  }
  const changedRatio = changed / first.length;
  if (changedRatio > 0.02) {
    throw new Error(
      `${failureMessage ?? "Composer region changed during the JS stall"} (${changedRatio.toFixed(3)})`,
    );
  }
} else {
  throw new Error(`Unknown command: ${command}`);
}
