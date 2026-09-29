#!/usr/bin/env node
// Draws the PandaOS panda from ellipses, samples it on a 32x32 grid and writes the frames the app
// plays (packages/app/src/components/panda-frames.ts). Pass --preview <file.png> to also write a sheet.
import { deflateSync, crc32 } from "node:zlib";
import { writeFileSync } from "node:fs";
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

function scene(x, y, pose) {
  const { eyesOpen, mouth, armUp, bamboo } = pose;
  let hit;
  // face details
  for (const side of [-1, 1]) {
    const ex = 16 + side * 4.7;
    if (eyesOpen) {
      if (ell(x, y, ex + side * 0.15, 14.6, 0.95, 1.05)) return "k";
      if (ell(x, y, ex - side * 0.2, 13.9, 1.65, 1.95)) return "w";
    } else if (ell(x, y, ex, 14.4, 1.75, 0.5)) return "w";
  }
  if (ell(x, y, 16, 17.7, 1.9, 1.25)) return "k";
  if (mouth) {
    if (ell(x, y, 16, 20.3, 1.5, 1.3)) return "m";
    if (ell(x, y, 16, 20.3, 2.2, 1.9)) return "k";
  } else if (ell(x, y, 16, 20.2, 1.9, 0.55)) return "k";
  for (const side of [-1, 1]) if (ell(x, y, 16 + side * 9.5, 18.6, 1.9, 1.2)) return "p";
  for (const side of [-1, 1]) {
    if (ell(x, y, 16 + side * 5.6, 14.4, 3.6, 4.7, -side * 0.55)) return "k";
  }
  // paw + bamboo in front of the head when raised
  const pawY = armUp ? 20.5 : 25.8;
  if (bamboo) {
    const top = armUp ? 14.5 : 21;
    if (x >= 22.6 && x <= 25.2 && y >= top && y <= 30.5)
      return Math.floor((y - top) / 4.2) % 3 === 2 ? "G" : "g";
  }
  if ((hit = ell(x, y, 24.0, pawY, 2.5, 2.6))) return blackShade(hit);
  // head
  if ((hit = ell(x, y, 16, 14, 12.2, 9.6))) return whiteShade(hit);
  // ears
  for (const side of [-1, 1])
    if ((hit = ell(x, y, 16 + side * 9.7, 5.4, 3.7, 3.7))) return blackShade(hit);
  // arms, body, feet
  if ((hit = ell(x, y, 7.6, 24.6, 2.6, 4.4, 0.32))) return blackShade(hit);
  if (!bamboo || !armUp)
    if ((hit = ell(x, y, 24.4, 24.6, 2.6, 4.4, -0.32)) && !bamboo) return blackShade(hit);
  if ((hit = ell(x, y, 16, 25, 8.4, 6.6))) return whiteShade(hit);
  for (const side of [-1, 1])
    if ((hit = ell(x, y, 16 + side * 4.7, 29.6, 3.6, 2.3))) return blackShade(hit);
  return null;
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

const WORK = [
  { eyesOpen: true, mouth: false, armUp: false, bamboo: true, dots: 0 },
  { eyesOpen: true, mouth: true, armUp: true, bamboo: true, dots: 1, oy: 0 },
  { eyesOpen: true, mouth: false, armUp: true, bamboo: true, dots: 2, oy: 0.6 },
  { eyesOpen: true, mouth: true, armUp: true, bamboo: true, dots: 3 },
  { eyesOpen: false, mouth: false, armUp: false, bamboo: true, dots: 3 },
  { eyesOpen: true, mouth: true, armUp: true, bamboo: true, dots: 2, oy: 0.6 },
  { eyesOpen: true, mouth: false, armUp: true, bamboo: true, dots: 1 },
  { eyesOpen: true, mouth: false, armUp: false, bamboo: true, dots: 0, oy: 0.6 },
].map((pose) => ({ ...pose, dots: pose.dots }));
const SALTO = Array.from({ length: 12 }, (_, i) => {
  const t = i / 12;
  const hop = Math.sin(t * Math.PI);
  const land = i === 0 || i === 11;
  return {
    eyesOpen: !(i > 2 && i < 9),
    mouth: i > 3 && i < 9,
    armUp: false,
    bamboo: false,
    dots: 0,
    angle: t * Math.PI * 2,
    oy: -hop * 3.2 + (land ? 0.8 : 0),
    sx: land ? 1.08 : 1,
    sy: land ? 0.94 : 1,
  };
});

const frames = { work: WORK.map(renderFrame), salto: SALTO.map(renderFrame) };
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "../packages/app/src/components/panda-frames.ts");
const body = `// Generated by scripts/generate-panda-sprite.mjs, do not edit by hand.
export const PANDA_GRID = ${N};

export const PANDA_PALETTE: Record<string, string> = ${JSON.stringify(PALETTE, null, 2)};

/** Chews bamboo, blinks and fills a thought bubble; one loop is ${WORK.length} frames. */
export const PANDA_WORK_FRAMES: readonly (readonly string[])[] = ${JSON.stringify(frames.work, null, 2)};

/** One somersault hop for the loading screen; ${SALTO.length} frames. */
export const PANDA_SALTO_FRAMES: readonly (readonly string[])[] = ${JSON.stringify(frames.salto, null, 2)};
`;
if (!process.argv.includes("--no-write")) writeFileSync(out, body);

const previewIdx = process.argv.indexOf("--preview");
if (previewIdx > 0) {
  const scale = 8;
  const all = [...frames.work, ...frames.salto];
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
