#!/usr/bin/env node
// Draws the PandaOS panda from ellipses, samples it on a 32x32 grid and writes the frames the app
// plays (packages/app/src/components/panda-frames.ts). Pass --preview <file.png> to also write a sheet.
import { deflateSync, crc32 } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const N = 32;
const PALETTE = {
  k: "#1f1e23", // black fur
  h: "#3b3a42", // black fur, lit edge
  o: "#0f0e12", // outline
  w: "#fbfaf6", // white fur
  s: "#dcd9cf", // white fur, shade
  p: "#f4a9a2", // cheeks
  m: "#e2707c", // open mouth
  g: "#79c862", // bamboo
  G: "#3f8f3a", // bamboo node
  b: "#8a8a86", // thought dot
};

function ell(x, y, cx, cy, rx, ry, rot = 0) {
  const dx = x - cx,
    dy = y - cy;
  const c = Math.cos(rot),
    s = Math.sin(rot);
  const u = (dx * c + dy * s) / rx,
    v = (-dx * s + dy * c) / ry;
  return u * u + v * v <= 1 ? { u, v } : null;
}
const whiteShade = (hit) => (hit.u * 0.55 + hit.v * 0.8 > 0.42 ? "s" : "w");
const blackShade = (hit) => (hit.u * -0.6 + hit.v * -0.8 > 0.45 ? "h" : "k");

const SIDES = [-1, 1];

function eyes(x, y, eyesOpen) {
  for (const side of SIDES) {
    const ex = 16 + side * 4.7;
    if (!eyesOpen) {
      if (ell(x, y, ex, 14.4, 1.75, 0.5)) return "w";
      continue;
    }
    if (ell(x, y, ex + side * 0.15, 14.6, 0.95, 1.05)) return "k";
    if (ell(x, y, ex - side * 0.2, 13.9, 1.65, 1.95)) return "w";
  }
  return null;
}

function mouthAndNose(x, y, mouth) {
  if (ell(x, y, 16, 17.7, 1.9, 1.25)) return "k";
  if (!mouth) return ell(x, y, 16, 20.2, 1.9, 0.55) ? "k" : null;
  if (ell(x, y, 16, 20.3, 1.5, 1.3)) return "m";
  return ell(x, y, 16, 20.3, 2.2, 1.9) ? "k" : null;
}

function face(x, y, pose) {
  const detail = eyes(x, y, pose.eyesOpen) ?? mouthAndNose(x, y, pose.mouth);
  if (detail) return detail;
  for (const side of SIDES) if (ell(x, y, 16 + side * 9.5, 18.6, 1.9, 1.2)) return "p";
  for (const side of SIDES) {
    if (ell(x, y, 16 + side * 5.6, 14.4, 3.6, 4.7, -side * 0.55)) return "k";
  }
  return null;
}

/** The paw and bamboo sit in front of the head while raised. */
function pawAndBamboo(x, y, pose) {
  const armT = pose.armT ?? 0;
  if (pose.bamboo) {
    const top = 21 - armT * 6.5;
    if (x >= 22.6 && x <= 25.2 && y >= top && y <= 30.5) {
      return Math.floor((y - top) / 4.2) % 3 === 2 ? "G" : "g";
    }
  }
  const hit = ell(x, y, 24.0, 25.8 - armT * 5.3, 2.5, 2.6);
  return hit ? blackShade(hit) : null;
}

function headAndEars(x, y) {
  let hit = ell(x, y, 16, 14, 12.2, 9.6);
  if (hit) return whiteShade(hit);
  for (const side of SIDES) {
    hit = ell(x, y, 16 + side * 9.7, 5.4, 3.7, 3.7);
    if (hit) return blackShade(hit);
  }
  return null;
}

function bodyAndLimbs(x, y, bamboo) {
  let hit = ell(x, y, 7.6, 24.6, 2.6, 4.4, 0.32);
  if (hit) return blackShade(hit);
  hit = !bamboo ? ell(x, y, 24.4, 24.6, 2.6, 4.4, -0.32) : null;
  if (hit) return blackShade(hit);
  hit = ell(x, y, 16, 25, 8.4, 6.6);
  if (hit) return whiteShade(hit);
  for (const side of SIDES) {
    hit = ell(x, y, 16 + side * 4.7, 29.6, 3.6, 2.3);
    if (hit) return blackShade(hit);
  }
  return null;
}

/** Layers front to back; the first one that covers the point wins. */
function scene(x, y, pose) {
  const front = face(x, y, pose);
  if (front) return front;
  const paw = pose.headOnly ? null : pawAndBamboo(x, y, pose);
  if (paw) return paw;
  const head = headAndEars(x, y);
  if (head || pose.headOnly) return head;
  return bodyAndLimbs(x, y, pose.bamboo);
}

function renderFrame(pose) {
  const { angle = 0, ox = 0, oy = 0, sx = 1, sy = 1, dots = 0 } = pose;
  const c = Math.cos(-angle),
    s = Math.sin(-angle);
  const grid = Array.from({ length: N }, () => Array(N).fill("."));
  for (let py = 0; py < N; py += 1) {
    for (let px = 0; px < N; px += 1) {
      let x = px + 0.5 - 16 - ox,
        y = py + 0.5 - 17 - oy;
      x /= sx;
      y /= sy;
      const rx = x * c - y * s + 16,
        ry = x * s + y * c + 17;
      grid[py][px] = scene(rx, ry, pose) ?? ".";
    }
  }
  // outline: empty cell touching a painted one
  const painted = (x, y) => grid[y]?.[x] !== undefined && grid[y][x] !== "." && grid[y][x] !== "o";
  const outline = [];
  for (let y = 0; y < N; y += 1)
    for (let x = 0; x < N; x += 1) {
      if (
        grid[y][x] === "." &&
        (painted(x - 1, y) || painted(x + 1, y) || painted(x, y - 1) || painted(x, y + 1))
      )
        outline.push([x, y]);
    }
  for (const [x, y] of outline) grid[y][x] = "o";
  for (let d = 0; d < dots; d += 1) grid[0][25 + d * 3] = "b";
  return grid.map((row) => row.join(""));
}

const ARM = [0, 0.3, 0.7, 1, 1, 1, 1, 1, 1, 0.7, 0.3, 0, 0, 0, 0, 0];
const WORK = ARM.map((armT, i) => ({
  eyesOpen: i !== 13,
  mouth: armT === 1 && i % 2 === 0,
  armT,
  bamboo: true,
  dots: [0, 0, 1, 1, 2, 2, 3, 3, 3, 3, 2, 2, 1, 1, 0, 0][i],
  oy: 0,
}));
const STAND = { eyesOpen: true, mouth: false, armT: 0, bamboo: false, dots: 0 };

const frames = { work: WORK.map(renderFrame), stand: renderFrame(STAND) };

const LOGO_POSE = {
  eyesOpen: true,
  mouth: false,
  armT: 0,
  bamboo: false,
  dots: 0,
  headOnly: true,
};
/** The head alone, cropped to its bounding box; the app logo and every icon are drawn from it. */
function cropped(rows) {
  const cells = rows
    .flatMap((row, y) => [...row].map((cell, x) => (cell === "." ? null : [x, y])))
    .filter(Boolean);
  const xs = cells.map(([x]) => x),
    ys = cells.map(([, y]) => y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return rows.slice(y0, y1 + 1).map((row) => row.slice(x0, x1 + 1));
}
const LOGO = cropped(renderFrame(LOGO_POSE));

const here = path.dirname(fileURLToPath(import.meta.url));
const framesFile = path.join(here, "../packages/app/src/components/panda-frames.ts");
const body = `// Generated by scripts/generate-panda-sprite.mjs, do not edit by hand.
export const PANDA_GRID = ${N};

export const PANDA_PALETTE: Record<string, string> = ${JSON.stringify(PALETTE, null, 2)};

/** Chews bamboo, blinks and fills a thought bubble; one loop is ${WORK.length} frames. */
export const PANDA_WORK_FRAMES: readonly (readonly string[])[] = ${JSON.stringify(frames.work, null, 2)};

/** The head alone, cropped: the app logo and every icon. */
export const PANDA_LOGO: readonly string[] = ${JSON.stringify(LOGO, null, 2)};

/** The whole panda standing still; the loading screen turns it into a somersault. */
export const PANDA_STAND: readonly string[] = ${JSON.stringify(frames.stand, null, 2)};
`;
if (!process.argv.includes("--no-write")) writeFileSync(framesFile, body);

const previewIdx = process.argv.indexOf("--preview");
if (previewIdx > 0) {
  const scale = 8;
  const all = [...frames.work, frames.stand];
  const cols = 10,
    rows = Math.ceil(all.length / cols);
  const W = cols * (N + 2) * scale,
    H = rows * (N + 2) * scale * 2;
  const buf = Buffer.alloc(W * H * 3);
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const put = (X, Y, rgb) => {
    const i = (Y * W + X) * 3;
    buf[i] = rgb[0];
    buf[i + 1] = rgb[1];
    buf[i + 2] = rgb[2];
  };
  all.forEach((frame, n) => {
    for (const [bgIdx, bg] of [
      [0, "#f7f6f2"],
      [1, "#0e0e10"],
    ]) {
      const bx = (n % cols) * (N + 2) * scale,
        by = (Math.floor(n / cols) * 2 + bgIdx) * (N + 2) * scale;
      for (let y = 0; y < (N + 2) * scale; y += 1)
        for (let x = 0; x < (N + 2) * scale; x += 1) put(bx + x, by + y, hex(bg));
      frame.forEach((row, y) =>
        [...row].forEach((cell, x) => {
          if (cell === ".") return;
          const rgb = hex(PALETTE[cell]);
          for (let dy = 0; dy < scale; dy += 1)
            for (let dx = 0; dx < scale; dx += 1)
              put(bx + (x + 1) * scale + dx, by + (y + 1) * scale + dy, rgb);
        }),
      );
    }
  });
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y += 1) {
    raw[y * (W * 3 + 1)] = 0;
    buf.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  writeFileSync(
    process.argv[previewIdx + 1],
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

// ---- icons: node scripts/generate-panda-sprite.mjs --icons <repo root> -------------------------
const iconsIdx = process.argv.indexOf("--icons");
if (iconsIdx > 0) {
  const root = path.resolve(process.argv[iconsIdx + 1] ?? path.join(here, ".."));
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const encodePng = (w, h, rgba) => {
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y += 1) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    const chunk = (type, data) => {
      const t = Buffer.from(type);
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
      return Buffer.concat([len, t, data, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  };
  /** size px square; the head fills `fill` of it with whole-pixel cells; bg: null | {color, radius} ; mono: white silhouette */
  const icon = (size, { fill = 0.72, bg = null, mono = false } = {}) => {
    const buf = Buffer.alloc(size * size * 4);
    if (bg) {
      const [r, g, b] = rgb(bg.color),
        rad = bg.radius * size;
      for (let y = 0; y < size; y += 1)
        for (let x = 0; x < size; x += 1) {
          const dx = Math.max(rad - x - 0.5, 0, x + 0.5 - (size - rad)),
            dy = Math.max(rad - y - 0.5, 0, y + 0.5 - (size - rad));
          if (dx * dx + dy * dy <= rad * rad) {
            const i = (y * size + x) * 4;
            buf[i] = r;
            buf[i + 1] = g;
            buf[i + 2] = b;
            buf[i + 3] = 255;
          }
        }
    }
    const cols = LOGO[0].length,
      rows = LOGO.length;
    const cell = Math.max(1, Math.floor((size * fill) / Math.max(cols, rows)));
    const ox = Math.floor((size - cols * cell) / 2),
      oy = Math.floor((size - rows * cell) / 2);
    LOGO.forEach((row, y) =>
      [...row].forEach((c, x) => {
        if (c === ".") return;
        const [r, g, b] = mono ? [255, 255, 255] : rgb(PALETTE[c]);
        for (let dy = 0; dy < cell; dy += 1)
          for (let dx = 0; dx < cell; dx += 1) {
            const i = ((oy + y * cell + dy) * size + ox + x * cell + dx) * 4;
            buf[i] = r;
            buf[i + 1] = g;
            buf[i + 2] = b;
            buf[i + 3] = 255;
          }
      }),
    );
    return encodePng(size, size, buf);
  };
  const paper = "#f7f6f2";
  const out = (rel, data) => {
    writeFileSync(path.join(root, rel), data);
    console.log("wrote", rel);
  };
  const square = { color: paper, radius: 0 };
  out("packages/app/assets/images/pandaos-app-icon.png", icon(1024, { bg: square, fill: 0.7 }));
  out("packages/app/assets/images/icon.png", icon(1024, { bg: square, fill: 0.7 }));
  out("packages/app/assets/images/splash-icon.png", icon(1024, { fill: 0.6 }));
  out("packages/app/assets/images/android-icon-foreground.png", icon(1024, { fill: 0.46 }));
  out("packages/app/assets/images/notification-icon.png", icon(1024, { fill: 0.7, mono: true }));
  out("packages/app/assets/images/favicon.png", icon(48, { fill: 0.94 }));
  const rounded = { color: paper, radius: 0.2237 };
  out("packages/desktop/assets/icon.png", icon(1024, { bg: rounded, fill: 0.56 }));
  out("packages/desktop/assets/icon-dev.png", icon(1024, { bg: rounded, fill: 0.56 }));
  for (const [name, size] of [
    ["32x32", 32],
    ["64x64", 64],
    ["128x128", 128],
    ["128x128@2x", 256],
  ])
    out(`packages/desktop/assets/${name}.png`, icon(size, { bg: rounded, fill: 0.7 }));
  // macOS iconset for `iconutil -c icns`
  const set = path.join(root, "packages/desktop/assets/icon.iconset");
  mkdirSync(set, { recursive: true });
  for (const s of [16, 32, 128, 256, 512]) {
    writeFileSync(path.join(set, `icon_${s}x${s}.png`), icon(s, { bg: rounded, fill: 0.64 }));
    writeFileSync(
      path.join(set, `icon_${s}x${s}@2x.png`),
      icon(s * 2, { bg: rounded, fill: 0.64 }),
    );
  }
  console.log("wrote packages/desktop/assets/icon.iconset");
  // Windows .ico with PNG payloads
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngs = sizes.map((s) => icon(s, { bg: rounded, fill: 0.8 }));
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = 6 + sizes.length * 16;
  const dir = sizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s === 256 ? 0 : s;
    e[1] = s === 256 ? 0 : s;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(pngs[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    return e;
  });
  const ico = Buffer.concat([head, ...dir, ...pngs]);
  out("packages/desktop/assets/icon.ico", ico);
  out("packages/website/public/favicon.ico", ico);
  // website SVGs
  const svg = (px) => {
    let r = "";
    LOGO.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        const c = row[x];
        if (c === ".") {
          x += 1;
          continue;
        }
        let e = x + 1;
        while (e < row.length && row[e] === c) e += 1;
        r += `<rect x="${x * px}" y="${y * px}" width="${(e - x) * px}" height="${px}" fill="${PALETTE[c]}"/>`;
        x = e;
      }
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${LOGO[0].length * px}" height="${LOGO.length * px}" viewBox="0 0 ${LOGO[0].length * px} ${LOGO.length * px}" shape-rendering="crispEdges">${r}</svg>\n`;
  };
  out("packages/website/public/logo.svg", svg(1));
  out("packages/website/public/favicon.svg", svg(1));
}
