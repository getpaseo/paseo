// Renders the App Store and Google Play screenshots from the native captures in
// raw/. Every image is resized with Lanczos to the exact pixel size it occupies
// on the canvas, and the page renders at device scale 1, so the browser never
// resamples a capture.
//
//   node assets/store-screenshots/render.mjs
//
// SF Pro is not redistributable. On macOS it comes from /System/Library/Fonts;
// elsewhere point SF_FONT_DIR at a folder holding SFNS.ttf copied from a Mac.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, "../..");
const raw = (device, name) => path.join(root, "raw", device, `${name}.png`);
const output = path.join(root, "output");

// Native captures per device: iPhone 16 Pro Max at 3x and iPad Pro 13-inch at
// 2x. The frame's screen radius and Dynamic Island are in capture pixels.
const DEVICES = {
  iphone: {
    capture: { width: 1320, height: 2868 },
    radius: 186,
    bezel: 22,
    island: { width: 378, height: 112, top: 33 },
  },
  ipad: { capture: { width: 2064, height: 2752 }, radius: 44, bezel: 30, island: null },
};

// Every title wraps to two lines and every subline fits on one; the renderer
// fails otherwise, because the device is placed from that fixed text height.
//
// Each scene names its capture per device, and a device entry may override the
// title or subline where the copy depends on the form factor.
//
// A callout lifts a region of a capture out of the device. `crop` is in native
// capture pixels, `zoom` is its size relative to the device screen (capped to
// the canvas width), and the callout is centred on the spot the crop comes
// from, moved by `shift` native pixels down the screen.
const SCENES = [
  {
    id: "sidebar",
    backdrop: "agents",
    title: "Run many coding agents at once",
    body: "See which agents are working and which need you.",
    iphone: { capture: "sidebar" },
    ipad: { capture: "sidebar" },
  },
  {
    id: "chat",
    title: "Your full dev environment on your phone",
    body: "Start agents and follow every edit and command.",
    iphone: { capture: "chat" },
    ipad: { capture: "chat", title: "Your full dev environment on your tablet" },
  },
  {
    id: "plugins",
    title: "Ask an agent to change the app itself",
    body: "This Deploys sheet is a plugin an agent wrote.",
    iphone: {
      capture: "plugin",
      callout: { from: "plugin-sheet", crop: [0, 1340, 1320, 1400], zoom: 1.04, shift: -1400 },
    },
    ipad: {
      capture: "plugin",
      body: "This Deploys panel is a plugin an agent wrote.",
      callout: { from: "plugin-sheet", crop: [670, 1486, 844, 970], zoom: 1.3, shift: -900 },
    },
  },
  {
    id: "review",
    title: "Review the diff before you merge",
    body: "Every file the agent changed, on its own branch.",
    iphone: {
      capture: "diff",
      callout: { from: "files", crop: [0, 1060, 1320, 870], zoom: 1.26, shift: 110 },
    },
    ipad: { capture: "diff" },
  },
  {
    id: "terminal",
    title: "A real terminal in every workspace",
    body: "Run the tests yourself, on your own machine.",
    iphone: {
      capture: "terminal",
      callout: { from: "terminal", crop: [0, 950, 1320, 460], zoom: 1.35, shift: 110 },
    },
    ipad: {
      capture: "terminal",
      callout: { from: "terminal", crop: [596, 640, 1010, 412], zoom: 1.35, shift: 650 },
    },
  },
];

// `textTop` is where the text starts when the device is sized by the canvas
// height. A canvas too narrow for that, like a tablet on 9:16, sizes the device
// by its width and centres the text and device instead.
const STORES = {
  apple: {
    device: "iphone",
    width: 1320,
    height: 2868,
    textTop: 230,
    titleSize: 100,
    bodySize: 46,
    textWidth: 1120,
  },
  google: {
    device: "iphone",
    width: 1440,
    height: 2560,
    textTop: 150,
    titleSize: 96,
    bodySize: 44,
    textWidth: 1200,
  },
  "apple-ipad": {
    device: "ipad",
    width: 2064,
    height: 2752,
    textTop: 200,
    titleSize: 124,
    bodySize: 56,
    textWidth: 1400,
  },
  "google-tablet": {
    device: "ipad",
    width: 1800,
    height: 3200,
    textTop: 200,
    titleSize: 136,
    bodySize: 60,
    textWidth: 1560,
  },
};

const TITLE_LINE = 1.06;
const BODY_LINE = 1.3;
const BODY_GAP = 30;
// The device starts this far below the text and runs BLEED off the bottom.
const GAP = 140;
const BLEED = 40;
const MARGIN = 56;
const COLORS = { canvas: "#101615", title: "#ffffff", body: "rgba(255, 255, 255, 0.58)" };

function findFont() {
  const dirs = [process.env.SF_FONT_DIR, "/System/Library/Fonts", "/Library/Fonts"].filter(Boolean);
  for (const dir of dirs) {
    const file = path.join(dir, "SFNS.ttf");
    if (existsSync(file)) return file;
  }
  throw new Error("SF Pro not found. Set SF_FONT_DIR to a folder containing SFNS.ttf from macOS.");
}

// The device fills the canvas from GAP below the text to just past the bottom
// edge, so a taller canvas gets a larger device rather than a larger gap. When
// that would be wider than the canvas, the device takes the full width and the
// text and the whole device sit centred, still GAP apart.
function deviceLayout(store, device) {
  const { capture, bezel } = device;
  const textHeight = 2 * store.titleSize * TITLE_LINE + BODY_GAP + store.bodySize * BODY_LINE;
  const tallest = store.height + BLEED - (store.textTop + textHeight + GAP) - 2 * bezel;
  const widest = store.width - 2 * MARGIN - 2 * bezel;
  const screenWidth = Math.min(Math.round((tallest * capture.width) / capture.height), widest);
  const screenHeight = Math.round((screenWidth * capture.height) / capture.width);
  const scale = screenWidth / capture.width;
  const width = screenWidth + 2 * bezel;
  const height = screenHeight + 2 * bezel;
  const textTop =
    screenWidth < widest
      ? store.height + BLEED - height - GAP - textHeight
      : (store.height - height - GAP - textHeight) / 2;
  const island = device.island && {
    width: Math.round(device.island.width * scale),
    height: Math.round(device.island.height * scale),
    top: Math.round(device.island.top * scale),
  };
  return {
    textTop: Math.round(textTop),
    left: Math.round((store.width - width) / 2),
    top: Math.round(textTop + textHeight + GAP),
    width,
    height,
    bezel,
    screenWidth,
    screenHeight,
    scale,
    radius: Math.round(device.radius * scale),
    island,
  };
}

function calloutLayout(callout, frame, store) {
  const [cropX, cropY, cropWidth, cropHeight] = callout.crop;
  const scale = Math.min(frame.scale * callout.zoom, (store.width - 2 * MARGIN) / cropWidth);
  const width = Math.round(cropWidth * scale);
  const height = Math.round(cropHeight * scale);
  const centreX = frame.left + frame.bezel + (cropX + cropWidth / 2) * frame.scale;
  const centreY = frame.top + frame.bezel + (cropY + cropHeight / 2 + callout.shift) * frame.scale;
  const clamp = (value, max) => Math.round(Math.min(Math.max(value, MARGIN), max - MARGIN));
  return {
    width,
    height,
    left: clamp(centreX - width / 2, store.width - width),
    top: clamp(centreY - height / 2, store.height - height),
  };
}

async function resize(source, crop, width, height, file) {
  let image = sharp(source);
  if (crop) image = image.extract({ left: crop[0], top: crop[1], width: crop[2], height: crop[3] });
  await image.resize(width, height, { kernel: "lanczos3" }).png().toFile(file);
  return pathToFileURL(file).href;
}

// Agent marks scattered behind the first panel, from the homepage's featured
// agents. Each entry is [mark, centre x, centre y, size, rotation], with the
// centre as a fraction of the canvas and the size as a fraction of its width.
const AGENT_MARKS = [
  ["ClaudeCodeIcon", 0.11, 0.075, 0.12, -14],
  ["CodexIcon", 0.89, 0.1, 0.13, 12],
  ["PiIcon", 0.07, 0.34, 0.1, 10],
  ["OmpIcon", 0.93, 0.37, 0.11, -10],
  ["OpenCodeIcon", 0.08, 0.6, 0.11, -8],
  ["CursorIcon", 0.92, 0.63, 0.1, 16],
  ["MuseCodeIcon", 0.07, 0.85, 0.11, 14],
  ["AntigravityIcon", 0.92, 0.88, 0.12, -12],
];

async function loadAgentMarks(work) {
  const bundle = path.join(work, "agent-icons.mjs");
  await build({
    entryPoints: [path.join(repo, "packages/website/src/components/agent-icons.tsx")],
    outfile: bundle,
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
  });
  const icons = await import(pathToFileURL(bundle).href);
  return Object.fromEntries(
    AGENT_MARKS.map(([name]) => [name, renderToStaticMarkup(createElement(icons[name]))]),
  );
}

function backdrop(store, marks) {
  return AGENT_MARKS.map(([name, x, y, size, rotation]) => {
    const side = Math.round(size * store.width);
    const left = Math.round(x * store.width - side / 2);
    const top = Math.round(y * store.height - side / 2);
    return `<div class="mark" style="left:${left}px;top:${top}px;width:${side}px;height:${side}px;transform:rotate(${rotation}deg)">${marks[name]}</div>`;
  }).join("");
}

function page({ store, shot, frame, screen, callout, calloutImage, font, marks }) {
  const behind = shot.backdrop === "agents" ? backdrop(store, marks) : "";
  const { island } = frame;
  const notch = island
    ? `<div class="island" style="top:${island.top}px;width:${island.width}px;height:${island.height}px;margin-left:-${island.width / 2}px;border-radius:${island.height / 2}px"></div>`
    : "";
  const lifted = callout
    ? `<img class="callout" src="${calloutImage}" style="left:${callout.left}px;top:${callout.top}px;width:${callout.width}px;height:${callout.height}px">`
    : "";
  return `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face { font-family: "SF Pro"; src: url("${pathToFileURL(font).href}"); font-weight: 1 1000; }
  * { margin: 0; box-sizing: border-box; }
  html, body { width: ${store.width}px; height: ${store.height}px; overflow: hidden; background: ${COLORS.canvas}; }
  body { position: relative; font-family: "SF Pro"; -webkit-font-smoothing: antialiased; }
  .text { position: absolute; top: ${frame.textTop}px; left: 0; right: 0; margin: 0 auto; width: ${store.textWidth}px; text-align: center; }
  .mark { position: absolute; color: #fff; opacity: 0.09; filter: grayscale(1) brightness(0) invert(1); }
  .mark svg { display: block; width: 100%; height: 100%; }
  h1 { color: ${COLORS.title}; font-size: ${store.titleSize}px; font-weight: 600; line-height: ${TITLE_LINE}; letter-spacing: -0.022em; text-wrap: balance; }
  p { margin-top: ${BODY_GAP}px; color: ${COLORS.body}; font-size: ${store.bodySize}px; font-weight: 400; line-height: ${BODY_LINE}; letter-spacing: -0.005em; text-wrap: balance; }
  .device { position: absolute; left: ${frame.left}px; top: ${frame.top}px; width: ${frame.width}px; height: ${frame.height}px; padding: ${frame.bezel}px; border-radius: ${frame.radius + frame.bezel}px; background: #040505; box-shadow: 0 0 0 3px #343b39, 0 0 0 5px #161b1a, 0 60px 140px rgba(0, 0, 0, 0.55); }
  .screen { position: relative; width: ${frame.screenWidth}px; height: ${frame.screenHeight}px; border-radius: ${frame.radius}px; overflow: hidden; }
  .screen img { display: block; width: ${frame.screenWidth}px; height: ${frame.screenHeight}px; }
  .island { position: absolute; left: 50%; background: #000; }
  .callout { position: absolute; display: block; border-radius: 36px; box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.14), 0 40px 100px rgba(0, 0, 0, 0.6); }
</style>
${behind}
<div class="text"><h1>${shot.title}</h1><p>${shot.body}</p></div>
<div class="device"><div class="screen"><img src="${screen}">${notch}</div></div>
${lifted}`;
}

async function renderStore(browser, name, store, font, marks, work) {
  const dir = path.join(output, name);
  await mkdir(dir, { recursive: true });
  const view = await browser.newPage({
    viewport: { width: store.width, height: store.height },
    deviceScaleFactor: 1,
  });
  const device = DEVICES[store.device];
  const frame = deviceLayout(store, device);
  const files = [];
  for (const [index, scene] of SCENES.entries()) {
    const stem = `${name}-${scene.id}`;
    const shot = { ...scene, ...scene[store.device] };
    const screen = await resize(
      raw(store.device, shot.capture),
      null,
      frame.screenWidth,
      frame.screenHeight,
      path.join(work, `${stem}-screen.png`),
    );
    const callout = shot.callout ? calloutLayout(shot.callout, frame, store) : null;
    const calloutImage = callout
      ? await resize(
          raw(store.device, shot.callout.from),
          shot.callout.crop,
          callout.width,
          callout.height,
          path.join(work, `${stem}-callout.png`),
        )
      : null;
    const html = path.join(work, `${stem}.html`);
    await writeFile(html, page({ store, shot, frame, screen, callout, calloutImage, font, marks }));
    await view.goto(pathToFileURL(html).href);
    await view.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images, (image) => image.decode()));
    });
    await expectLines(view, "h1", 2, `${stem} title`);
    await expectLines(view, "p", 1, `${stem} subline`);
    const file = path.join(dir, `${String(index + 1).padStart(2, "0")}-${scene.id}.png`);
    await sharp(await view.screenshot())
      .removeAlpha()
      .png()
      .toFile(file);
    files.push(file);
    console.log(path.relative(repo, file));
  }
  await view.close();
  return files;
}

async function expectLines(view, selector, expected, label) {
  const lines = await view.$eval(selector, (element) =>
    Math.round(element.clientHeight / parseFloat(getComputedStyle(element).lineHeight)),
  );
  if (lines !== expected) throw new Error(`${label} wraps to ${lines} lines, expected ${expected}`);
}

async function renderPreview(rows) {
  const tile = 440;
  const gap = 40;
  const resized = [];
  let top = gap;
  let width = 0;
  for (const files of rows) {
    let left = gap;
    let rowHeight = 0;
    for (const file of files) {
      const meta = await sharp(file).metadata();
      const height = Math.round((meta.height * tile) / meta.width);
      const input = await sharp(file).resize(tile, height, { kernel: "lanczos3" }).toBuffer();
      resized.push({ input, left, top });
      left += tile + gap;
      rowHeight = Math.max(rowHeight, height);
    }
    width = Math.max(width, left);
    top += rowHeight + gap;
  }
  const file = path.join(output, "preview.png");
  await sharp({ create: { width, height: top, channels: 3, background: "#070a09" } })
    .composite(resized)
    .png()
    .toFile(file);
  console.log(path.relative(repo, file));
}

const font = findFont();
const work = await mkdtemp(path.join(os.tmpdir(), "paseo-store-"));
const browser = await chromium.launch({ headless: true });
try {
  const marks = await loadAgentMarks(work);
  const rows = [];
  for (const [name, store] of Object.entries(STORES)) {
    rows.push(await renderStore(browser, name, store, font, marks, work));
  }
  await renderPreview(rows);
} finally {
  await browser.close();
  await rm(work, { recursive: true, force: true });
}
