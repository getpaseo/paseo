// Generates every Paseo app icon from the canonical butterfly mark.
//
//   node assets/brand/build-app-icons.mjs
//
// The artwork is the white butterfly on a black tile. A desktop development build gets the same
// tile drawn as a blueprint, so it is never mistaken for an installed app.
//
// The icons that ship are flat. Each platform masks and lights its own icons, and artwork that
// arrives already lit ends up lit twice. The lit finish is a baked approximation of the Liquid
// Glass material macOS draws for Icon Composer icons. It is written to app-icons/ so it stays
// available, and nothing consumes it.
//
// A packaged Mac app gets its icon from the Icon Composer document in the desktop assets, which
// macOS masks and lights itself. macOS draws a dev build's Dock icon and an .icns exactly as
// supplied, so those carry the system's tile in the artwork. Its geometry is measured from the icon
// macOS 27 draws for that document: the tile covers 824 of the 1024 canvas pixels and its corners
// are continuous curves with a radius of 26.4% of the tile.
//
// sharp is not a declared dependency. It resolves from the workspace root, the way opentype.js
// does for build.mjs.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const brandDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(brandDir, "../..");
const brandMarkPath = path.join(brandDir, "marks/paseo-white.svg");

const CANVAS = 1024;
const MACOS_TILE_ON_CANVAS = 824 / CANVAS;
// Windows and Linux have no icon grid, and a tile with the macOS margin looks small next to their
// other icons.
const WINDOWS_LINUX_TILE_ON_CANVAS = 928 / CANVAS;

// Artwork is drawn in the brand mark's own 700-unit box, which the tile fills.
const TILE = 700;
const TILE_RADIUS = 185;
const MARK_INK = 527;
// Scaled down, the mark keeps clear of the tile's corners and covers as much of the tile as the
// glyphs in Apple's icons do.
const MARK_SCALE = 0.9;
const MARK_INK_ON_TILE = (MARK_INK * MARK_SCALE) / TILE;

// Android shows the middle 72 of an adaptive icon's 108 units.
const ANDROID_ADAPTIVE_VISIBLE = 72 / 108;
const NOTIFICATION_MARK_INK = 0.75;

// Apple's continuous corner. Each pair is a distance back along the incoming edge and a distance
// along the outgoing edge, in units of the corner radius.
const CORNER_SEGMENTS = [
  ["C", [1.08849296, 0], [0.86840694, 0], [0.66993427, 0.065496]],
  ["L", [0.63149399, 0.074911]],
  ["C", [0.37282392, 0.16905899], [0.16905899, 0.37282392], [0.074911, 0.63149399]],
  ["L", [0.065496, 0.66993427]],
  ["C", [0, 0.86840694], [0, 1.08849296], [0, 1.52866483]],
];
const CORNER_START = [1.52866483, 0];

function continuousSquarePath(inset) {
  const near = inset;
  const far = TILE - inset;
  const radius = TILE_RADIUS - inset;
  const corners = [
    { at: [far, near], incoming: [1, 0], outgoing: [0, 1] },
    { at: [far, far], incoming: [0, 1], outgoing: [-1, 0] },
    { at: [near, far], incoming: [-1, 0], outgoing: [0, -1] },
    { at: [near, near], incoming: [0, -1], outgoing: [1, 0] },
  ];
  const commands = corners.map(({ at, incoming, outgoing }, cornerIndex) => {
    const point = ([back, along]) =>
      [0, 1]
        .map((axis) => at[axis] - incoming[axis] * back * radius + outgoing[axis] * along * radius)
        .map((value) => Number(value.toFixed(2)))
        .join(" ");
    const segments = CORNER_SEGMENTS.map(
      ([command, ...points]) => `${command}${points.map(point).join(" ")}`,
    );
    return `${cornerIndex === 0 ? "M" : "L"}${point(CORNER_START)}${segments.join("")}`;
  });
  return `${commands.join("")}Z`;
}

const TILE_SHAPE = `<path d="${continuousSquarePath(0)}" />`;
const FILL_TILE = `<rect width="${TILE}" height="${TILE}" fill="url(#surface)" />`;

const PRODUCTION = {
  flat: {
    defs: `<linearGradient id="surface"><stop stop-color="#000000" /></linearGradient>`,
    surface: FILL_TILE,
  },
  lit: {
    defs: `
    <linearGradient id="surface" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#202022" />
      <stop offset="1" stop-color="#0E0E10" />
    </linearGradient>`,
    surface: FILL_TILE,
    tileEdge: { color: "#000000", opacity: 0.75 },
    markEdge: { color: "#4A5568", opacity: 0.45 },
    markShadow: { color: "#000000", opacity: 0.5 },
  },
};

const GRID_DIVISIONS = 8;
const GRID_MAJOR_EVERY = 2;
const OUTLINE_INSET = 28;

function gridLines(isIncluded) {
  const step = TILE / GRID_DIVISIONS;
  const segments = [];
  for (let index = 1; index < GRID_DIVISIONS; index += 1) {
    if (!isIncluded(index)) continue;
    const at = index * step;
    segments.push(`M${at} 0V${TILE}`, `M0 ${at}H${TILE}`);
  }
  return segments.join("");
}

const isMajorLine = (index) => index % GRID_MAJOR_EVERY === 0;

const BLUEPRINT_SHEET = {
  defs: `
    <linearGradient id="surface" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#05C2FE" />
      <stop offset="0.5" stop-color="#0191FD" />
      <stop offset="1" stop-color="#026CFA" />
    </linearGradient>`,
  surface: `
    ${FILL_TILE}
    <g fill="none" stroke="#FFFFFF">
      <path d="${gridLines((index) => !isMajorLine(index))}" stroke-opacity="0.16" stroke-width="1.5" />
      <path d="${gridLines(isMajorLine)}" stroke-opacity="0.34" stroke-width="2" />
      <circle cx="${TILE / 2}" cy="${TILE / 2}" r="${TILE / 2 - OUTLINE_INSET}" stroke-opacity="0.45" stroke-width="2" stroke-dasharray="10 8" />
      <path d="${continuousSquarePath(OUTLINE_INSET)}" stroke-opacity="0.34" stroke-width="2" />
    </g>`,
};

const BLUEPRINT = {
  flat: BLUEPRINT_SHEET,
  lit: {
    ...BLUEPRINT_SHEET,
    tileEdge: { color: "#0034B4", opacity: 0.55 },
    markEdge: { color: "#1E5FD0", opacity: 0.5 },
    markShadow: { color: "#00308F", opacity: 0.4 },
  },
};

// The lit finish, tuned against Apple's own renders. The light comes from straight above: a
// layer's upward-facing edge gets a bright highlight, its downward-facing edge a fainter one, and
// its side edges darken.
//
// An edge highlight is the part of the layer that a vertically shifted copy does not cover. A
// vertical blur of the shifted copy makes the highlight brightest at the edge and absent on
// vertical edges. A wider, round blur of the same band dims it where the edge turns away from
// the light, which is what keeps the tile's corners quieter than its top.
function glassFilter({ id, edge, edgeWidth, lightWidth, upperLight, lowerLight, shadow }) {
  const light = (name, direction, opacity) => `
      <feOffset in="SourceAlpha" dy="${direction * lightWidth}" />
      <feGaussianBlur stdDeviation="0 ${lightWidth}" result="${name}Shifted" />
      <feComposite in="SourceAlpha" in2="${name}Shifted" operator="out" result="${name}Edge" />
      <feOffset in="SourceAlpha" dy="${direction * lightWidth * 2}" result="${name}Far" />
      <feComposite in="SourceAlpha" in2="${name}Far" operator="out" />
      <feGaussianBlur stdDeviation="${lightWidth * 3}" />
      <feComponentTransfer><feFuncA type="gamma" exponent="3" amplitude="65" /></feComponentTransfer>
      <feComposite in2="${name}Edge" operator="arithmetic" k1="1" result="${name}Shape" />
      <feFlood flood-color="#FFFFFF" flood-opacity="${opacity}" />
      <feComposite in2="${name}Shape" operator="in" result="${name}" />`;
  const dropShadow = shadow
    ? `
      <feGaussianBlur in="SourceAlpha" stdDeviation="${shadow.blur}" />
      <feOffset dy="${shadow.offset}" result="shadowShape" />
      <feFlood flood-color="${shadow.color}" flood-opacity="${shadow.opacity}" />
      <feComposite in2="shadowShape" operator="in" result="shadow" />`
    : "";
  return `
    <filter id="${id}" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">${dropShadow}
      <feMorphology in="SourceAlpha" operator="erode" radius="${edgeWidth * 0.6}" />
      <feGaussianBlur stdDeviation="${edgeWidth}" result="core" />
      <feFlood flood-color="${edge.color}" flood-opacity="${edge.opacity}" />
      <feComposite in2="core" operator="out" />
      <feComposite in2="SourceAlpha" operator="in" result="edge" />
${light("upper", 1, upperLight)}
${light("lower", -1, lowerLight)}
      <feMerge>
        ${shadow ? '<feMergeNode in="shadow" />' : ""}
        <feMergeNode in="SourceGraphic" />
        <feMergeNode in="edge" />
        <feMergeNode in="upper" />
        <feMergeNode in="lower" />
      </feMerge>
    </filter>`;
}

function litDefs({ tileEdge, markEdge, markShadow }) {
  const markBody = `
    <linearGradient id="markBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" />
      <stop offset="0.4" stop-color="#FFFFFF" />
      <stop offset="1" stop-color="#D9DFE9" />
    </linearGradient>`;
  const tileGlass = glassFilter({
    id: "tileGlass",
    edge: tileEdge,
    edgeWidth: 3,
    lightWidth: 3.6,
    upperLight: 0.82,
    lowerLight: 0.45,
  });
  const markGlass = glassFilter({
    id: "markGlass",
    edge: markEdge,
    edgeWidth: 1.2,
    lightWidth: 1.6,
    upperLight: 1,
    lowerLight: 0.6,
    shadow: { ...markShadow, blur: 9, offset: 8 },
  });
  return `${markBody}${tileGlass}${markGlass}`;
}

function brandMark(stroke) {
  const svg = readFileSync(brandMarkPath, "utf8");
  const outline = svg.match(/\bd="([^"]+)"/);
  const strokeWidth = svg.match(/\bstroke-width="([^"]+)"/);
  if (!outline || !strokeWidth) {
    throw new Error(`No stroked mark path in ${brandMarkPath}`);
  }
  // The path carries its own `fill="none"`: Icon Composer ignores the one on the <svg> element and
  // draws a hairline from the end of the stroke back to its start.
  return `<path d="${outline[1]}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth[1]}" stroke-linecap="round" stroke-linejoin="round" />`;
}

function scaledAboutCentre(scale, content) {
  const centre = TILE / 2;
  return `<g transform="translate(${centre} ${centre}) scale(${scale}) translate(${-centre} ${-centre})">${content}</g>`;
}

// A square canvas with the 700-unit artwork box centred on it and covering `boxOnCanvas` of its
// width.
function canvasSvg(boxOnCanvas, content) {
  const canvasUnits = TILE / boxOnCanvas;
  const origin = (TILE - canvasUnits) / 2;
  return [
    `<svg width="${CANVAS}" height="${CANVAS}" viewBox="${origin} ${origin} ${canvasUnits} ${canvasUnits}" fill="none" xmlns="http://www.w3.org/2000/svg">`,
    content,
    "</svg>",
  ].join("\n");
}

// The tile with the mark on it. A masked tile has the continuous corners cut into the artwork. A
// square tile is for platforms that apply their own mask.
function tileIconSvg({ artwork, finish, tileOnCanvas, corners }) {
  const look = artwork[finish];
  const isLit = finish === "lit";
  const filtered = (id, content) => (isLit ? `<g filter="url(#${id})">${content}</g>` : content);
  const tile =
    corners === "continuous" ? `<g clip-path="url(#tile)">${look.surface}</g>` : look.surface;
  const mark = scaledAboutCentre(MARK_SCALE, brandMark(isLit ? "url(#markBody)" : "#FFFFFF"));
  return canvasSvg(
    tileOnCanvas,
    [
      `<defs><clipPath id="tile">${TILE_SHAPE}</clipPath>${look.defs}${isLit ? litDefs(look) : ""}</defs>`,
      filtered("tileGlass", tile),
      filtered("markGlass", mark),
    ].join("\n"),
  );
}

// The white mark alone on a transparent canvas, its ink covering `inkOnCanvas` of the width.
function markOnlySvg(inkOnCanvas) {
  return canvasSvg((inkOnCanvas * TILE) / MARK_INK, brandMark("#FFFFFF"));
}

function rasterizer(svg) {
  const source = Buffer.from(svg);
  const sized = (size) => sharp(source).resize(size, size);
  return {
    png: (size) => sized(size).png({ compressionLevel: 9 }).toBuffer(),
    opaquePng: (size) => sized(size).removeAlpha().png({ compressionLevel: 9 }).toBuffer(),
    rgba: (size) => sized(size).ensureAlpha().raw().toBuffer(),
  };
}

// ICO: a directory of PNG-encoded entries. A size byte of 0 means 256.
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  let offset = header.length + entries.length * 16;
  const directory = entries.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size % 256, 0);
    entry.writeUInt8(size % 256, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });

  return Buffer.concat([header, ...directory, ...entries.map((entry) => entry.png)]);
}

function icnsElement(type, data) {
  const header = Buffer.alloc(8);
  header.write(type, 0, "latin1");
  header.writeUInt32BE(header.length + data.length, 4);
  return Buffer.concat([header, data]);
}

// The 16 and 32 pixel ICNS slots predate PNG: three run-length-encoded colour planes plus a
// separate 8-bit alpha mask. A control byte below 128 copies the next (byte + 1) values, so
// literal-only chunks are a valid encoding.
function icnsLegacyElements(colorType, maskType, rgba) {
  const pixels = rgba.length / 4;
  const chunks = [];
  for (let channel = 0; channel < 3; channel += 1) {
    for (let start = 0; start < pixels; start += 128) {
      const length = Math.min(128, pixels - start);
      const chunk = Buffer.alloc(length + 1);
      chunk[0] = length - 1;
      for (let index = 0; index < length; index += 1) {
        chunk[index + 1] = rgba[(start + index) * 4 + channel];
      }
      chunks.push(chunk);
    }
  }
  const mask = Buffer.alloc(pixels);
  for (let index = 0; index < pixels; index += 1) {
    mask[index] = rgba[index * 4 + 3];
  }
  return [icnsElement(colorType, Buffer.concat(chunks)), icnsElement(maskType, mask)];
}

async function encodeIcns(icon) {
  const pngSlots = [
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024],
    ["ic11", 32],
    ["ic12", 64],
    ["ic13", 256],
    ["ic14", 512],
  ];
  const elements = [
    ...icnsLegacyElements("is32", "s8mk", await icon.rgba(16)),
    ...icnsLegacyElements("il32", "l8mk", await icon.rgba(32)),
  ];
  for (const [type, size] of pngSlots) {
    elements.push(icnsElement(type, await icon.png(size)));
  }
  const body = Buffer.concat(elements);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "latin1");
  header.writeUInt32BE(header.length + body.length, 4);
  return Buffer.concat([header, body]);
}

// The Icon Composer document macOS 26 and later build the app icon from. The canvas is the whole
// tile: macOS adds the mask, the margin, and the lighting. The mark stays opaque so it reads as
// solid white on the black tile.
function iconComposerFiles() {
  const layer = "butterfly.svg";
  const document = {
    fill: { solid: "srgb:0.00000,0.00000,0.00000,1.00000" },
    groups: [
      {
        layers: [{ "image-name": layer, name: "butterfly" }],
        shadow: { kind: "neutral", opacity: 0.5 },
        translucency: { enabled: false, value: 0.5 },
      },
    ],
    "supported-platforms": { squares: ["macOS"] },
  };
  return [
    ["icon.json", `${JSON.stringify(document, null, 2)}\n`],
    [`Assets/${layer}`, `${markOnlySvg(MARK_INK_ON_TILE)}\n`],
  ];
}

function write(file, data) {
  const target = path.join(repoRoot, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, data);
}

function desktopIcon(artwork, finish, tileOnCanvas) {
  return rasterizer(tileIconSvg({ artwork, finish, tileOnCanvas, corners: "continuous" }));
}

async function buildDesktopIcons() {
  const production = desktopIcon(PRODUCTION, "flat", WINDOWS_LINUX_TILE_ON_CANVAS);
  const assets = "packages/desktop/assets";

  const pngFiles = [
    ["icon.png", 512],
    ["32x32.png", 32],
    ["64x64.png", 64],
    ["128x128.png", 128],
    ["128x128@2x.png", 256],
  ];
  for (const [file, size] of pngFiles) {
    write(`${assets}/${file}`, await production.png(size));
  }

  const icoEntries = [];
  for (const size of [32, 16, 24, 48, 64, 256]) {
    icoEntries.push({ size, png: await production.png(size) });
  }
  write(`${assets}/icon.ico`, encodeIco(icoEntries));
  write(
    `${assets}/icon.icns`,
    await encodeIcns(desktopIcon(PRODUCTION, "flat", MACOS_TILE_ON_CANVAS)),
  );
  for (const [file, content] of iconComposerFiles()) {
    write(`${assets}/icon.icon/${file}`, content);
  }
  write(
    `${assets}/icon-dev.png`,
    await desktopIcon(BLUEPRINT, "flat", MACOS_TILE_ON_CANVAS).png(CANVAS),
  );
}

async function buildMobileIcons() {
  const flat = (corners) =>
    rasterizer(tileIconSvg({ artwork: PRODUCTION, finish: "flat", tileOnCanvas: 1, corners }));
  // iOS masks these itself, and Expo flattens any transparency in the app icon onto white.
  const square = flat("square");
  // Shown as supplied, so the corners are part of the artwork.
  const masked = flat("continuous");
  const adaptiveForeground = rasterizer(markOnlySvg(ANDROID_ADAPTIVE_VISIBLE * MARK_INK_ON_TILE));
  const notification = rasterizer(markOnlySvg(NOTIFICATION_MARK_INK));

  write("packages/app/assets/images/icon.png", await square.opaquePng(1024));
  write("packages/app/public/apple-touch-icon.png", await square.opaquePng(180));
  write(
    "packages/app/assets/images/android-icon-foreground.png",
    await adaptiveForeground.png(1024),
  );
  write("packages/app/assets/images/notification-icon.png", await notification.png(96));
  write("packages/app/assets/images/splash-icon.png", await masked.png(1024));
  write("packages/app/public/pwa-icon-192.png", await masked.png(192));
  write("packages/app/public/pwa-icon-512.png", await masked.png(512));
  write("fastlane/metadata/android/en-US/images/icon.png", await masked.png(512));
}

async function buildLitIcons() {
  for (const [file, artwork] of [
    ["paseo-lit.png", PRODUCTION],
    ["paseo-dev-lit.png", BLUEPRINT],
  ]) {
    const icon = desktopIcon(artwork, "lit", MACOS_TILE_ON_CANVAS);
    write(`assets/brand/app-icons/${file}`, await icon.png(CANVAS));
  }
}

await buildDesktopIcons();
await buildMobileIcons();
await buildLitIcons();
