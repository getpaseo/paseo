import fs from "node:fs/promises";
import process from "node:process";
import sharp from "sharp";

const [, , command, ...args] = process.argv;

// uiautomator reports bounds clipped to the visible parent and omits nodes
// that are entirely off screen.
function xmlBounds(snapshot, attribute) {
  const node = snapshot.match(new RegExp(`<node[^>]*${attribute}[^>]*>`));
  if (!node) throw new Error(`Missing node: ${attribute}`);
  const bounds = node[0].match(/bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/);
  if (!bounds) throw new Error(`Missing bounds: ${attribute}`);
  return {
    left: Number(bounds[1]),
    top: Number(bounds[2]),
    right: Number(bounds[3]),
    bottom: Number(bounds[4]),
  };
}
const xmlBoundsById = (snapshot, id) => xmlBounds(snapshot, `resource-id="${id}"`);
const xmlEditTextBounds = (snapshot) => xmlBounds(snapshot, 'class="android.widget.EditText"');
const boundsHeight = (bounds) => bounds.bottom - bounds.top;

if (command === "stream-moved") {
  const [beforePath, afterPath, topArgument = "330", heightArgument = "1000"] = args;
  const { width } = await sharp(beforePath).metadata();
  const region = {
    left: 16,
    top: Number(topArgument),
    width: width - 32,
    height: Number(heightArgument),
  };
  const [before, after] = await Promise.all(
    [beforePath, afterPath].map((path) =>
      sharp(path).extract(region).removeAlpha().raw().toBuffer(),
    ),
  );
  let changed = 0;
  for (let offset = 0; offset < before.length; offset += 3) {
    if (
      [0, 1, 2].some((channel) => Math.abs(before[offset + channel] - after[offset + channel]) > 8)
    )
      changed++;
  }
  const fraction = changed / (before.length / 3);
  // Exclude the scrollbar rail and require more than incidental icon/antialias changes.
  if (fraction < 0.01)
    throw new Error(
      `Native swipe did not move stream content: ${(fraction * 100).toFixed(2)}% changed`,
    );
  process.stdout.write(
    `Native swipe moved stream content: ${(fraction * 100).toFixed(2)}% changed\n`,
  );
} else if (command === "snapshot-xml") {
  const [inputPath, outputPath] = args;
  const snapshot = JSON.parse(await fs.readFile(inputPath, "utf8"));
  if (!snapshot.success || !snapshot.data.nodes.length) throw new Error("Empty device snapshot");
  const escape = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const nodes = snapshot.data.nodes
    .filter((node) => node.rect && node.visibleToUser !== false)
    .map((node) => {
      const { x, y, width, height } = node.rect;
      return `<node class="${escape(node.type)}" resource-id="${escape(node.identifier)}" content-desc="${escape(node.label)}" bounds="[${Math.round(x)},${Math.round(y)}][${Math.round(x + width)},${Math.round(y + height)}]" />`;
    });
  await fs.writeFile(outputPath, `<hierarchy>${nodes.join("")}</hierarchy>`);
} else if (command === "xml-background-point") {
  const [snapshotPath, surface] = args;
  const snapshot = await fs.readFile(snapshotPath, "utf8");
  const bounds = xmlBoundsById(
    snapshot,
    surface === "header" ? "composer-dock-header" : "composer-dock-content",
  );
  process.stdout.write(
    `${surface === "header" ? bounds.right - 4 : bounds.left + 4} ${bounds.bottom - 8}\n`,
  );
} else if (command === "xml-content-follow-growth") {
  const [beforePath, afterPath] = args;
  const before = await fs.readFile(beforePath, "utf8");
  const after = await fs.readFile(afterPath, "utf8");
  const growth = boundsHeight(xmlEditTextBounds(after)) - boundsHeight(xmlEditTextBounds(before));
  const movement =
    xmlBoundsById(before, "composer-dock-content").bottom -
    xmlBoundsById(after, "composer-dock-content").bottom;
  if (growth <= 0 || Math.abs(movement - growth) > 1)
    throw new Error(`Content moved ${movement}px for ${growth}px input growth`);
  process.stdout.write(`Content followed input growth: ${growth}px\n`);
} else if (command === "xml-composer-contained") {
  const [snapshotPath, imeTopArgument, densityArgument] = args;
  const snapshot = await fs.readFile(snapshotPath, "utf8");
  const boundsFor = (id) => xmlBoundsById(snapshot, id);
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
  const [snapshotPath, identifier, edge] = args;
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  const node = snapshot.data.nodes.find(
    (candidate) =>
      candidate.identifier === identifier ||
      candidate.label === identifier ||
      (identifier === "editable" && candidate.type.endsWith("EditText")),
  );
  if (!node) throw new Error(`Missing node: ${identifier}`);
  const { x, y, width, height } = node.rect;
  const targetX = edge === "right" ? x + width - 4 : x + width / 2;
  process.stdout.write(`${Math.round(targetX)} ${Math.round(y + height / 2)} ${height}\n`);
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
} else if (command === "xml-fields-follow-growth") {
  // Growing the draft with the keyboard open moves the setup fields up by the
  // same amount; the composer never eats their bottom rows.
  const [beforePath, afterPath] = args;
  const [before, after] = await Promise.all([
    fs.readFile(beforePath, "utf8"),
    fs.readFile(afterPath, "utf8"),
  ]);
  const growth = boundsHeight(xmlEditTextBounds(after)) - boundsHeight(xmlEditTextBounds(before));
  if (growth <= 0) throw new Error(`Composer did not grow (${growth}px)`);
  const fieldsBefore = xmlBoundsById(before, "new-workspace-launch-trigger");
  const fieldsAfter = xmlBoundsById(after, "new-workspace-launch-trigger");
  const moved = fieldsBefore.bottom - fieldsAfter.bottom;
  if (Math.abs(moved - growth) > 2) {
    throw new Error(`Setup fields moved ${moved}px while the composer grew ${growth}px`);
  }
  process.stdout.write(`Setup fields followed composer growth: ${growth}px\n`);
} else if (command === "xml-fields-above-composer") {
  // With the keyboard closed the setup fields sit fully visible above the composer.
  const [snapshotPath] = args;
  const snapshot = await fs.readFile(snapshotPath, "utf8");
  const fields = xmlBoundsById(snapshot, "new-workspace-launch-trigger");
  const content = xmlBoundsById(snapshot, "composer-viewport-content");
  if (boundsHeight(fields) < 40) {
    throw new Error(`Setup fields are clipped: launch row height=${boundsHeight(fields)}`);
  }
  if (fields.bottom > content.top) {
    throw new Error(
      `Setup fields overlap the composer: fields=${fields.bottom}, composer=${content.top}`,
    );
  }
  process.stdout.write(
    `Setup fields visible above the composer: ${fields.bottom} <= ${content.top}\n`,
  );
} else if (command === "same-input-height") {
  const [firstPath, secondPath] = args;
  const readInputHeight = async (snapshotPath) => {
    if (snapshotPath.endsWith(".xml")) {
      return boundsHeight(xmlEditTextBounds(await fs.readFile(snapshotPath, "utf8")));
    }
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
