import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appAssets = path.join(root, "packages/app/assets/images");
const desktopAssets = path.join(root, "packages/desktop/assets");
const enhancedDesktop = path.join(desktopAssets, "enhanced");
const badge = await readFile(path.join(appAssets, "enhanced-badge.svg"));
await mkdir(enhancedDesktop, { recursive: true });
await sharp(badge).png().toFile(path.join(appAssets, "enhanced-badge.png"));

// The original artwork is never rewritten. Only this corner gains the badge.
async function stamp(source, destination, scale = 1) {
  const { width, height } = await sharp(source).metadata();
  const size = Math.round(width * 0.26 * scale);
  const centerX = width * (0.5 + 0.29 * scale);
  const centerY = height * (0.5 - 0.28 * scale);
  const overlay = await sharp(badge).resize(size, size).png().toBuffer();
  await sharp(source)
    .composite([
      {
        input: overlay,
        left: Math.round(centerX - size / 2),
        top: Math.round(centerY - size / 2),
      },
    ])
    .png()
    .toFile(destination);
}

for (const name of ["icon", "splash-icon", "favicon"]) {
  await stamp(path.join(appAssets, `${name}.png`), path.join(appAssets, `${name}-enhanced.png`));
}
// Keep the entire badge within Android's adaptive icon safe circle.
await stamp(
  path.join(appAssets, "android-icon-foreground.png"),
  path.join(appAssets, "android-icon-foreground-enhanced.png"),
  0.54,
);
await stamp(path.join(desktopAssets, "icon.png"), path.join(enhancedDesktop, "icon.png"));

for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  await sharp(path.join(enhancedDesktop, "icon.png"))
    .resize(size, size)
    .png()
    .toFile(path.join(enhancedDesktop, `${size}x${size}.png`));
}

// PNG-backed ICO entries preserve transparency without another build dependency.
const sizes = [16, 32, 48, 64, 128, 256];
const frames = await Promise.all(
  sizes.map((size) => sharp(path.join(enhancedDesktop, `${size}x${size}.png`)).toBuffer()),
);
const directory = Buffer.alloc(6 + frames.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(frames.length, 4);
let offset = directory.length;
frames.forEach((frame, index) => {
  const entry = 6 + index * 16;
  directory[entry] = sizes[index] % 256;
  directory[entry + 1] = sizes[index] % 256;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(frame.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += frame.length;
});
await writeFile(path.join(enhancedDesktop, "icon.ico"), Buffer.concat([directory, ...frames]));

if (process.platform === "darwin") {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "paseo-enhanced-icons-"));
  try {
    const original = path.join(temporary, "original.png");
    const stamped = path.join(temporary, "enhanced.png");
    const iconset = path.join(temporary, "enhanced.iconset");
    await mkdir(iconset);
    execFileSync(
      "/usr/bin/sips",
      ["-s", "format", "png", path.join(desktopAssets, "icon.icns"), "--out", original],
      { stdio: "ignore" },
    );
    await stamp(original, stamped);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const density of [1, 2]) {
        await sharp(stamped)
          .resize(size * density, size * density)
          .png()
          .toFile(path.join(iconset, `icon_${size}x${size}${density === 2 ? "@2x" : ""}.png`));
      }
    }
    execFileSync("/usr/bin/iconutil", [
      "-c",
      "icns",
      iconset,
      "-o",
      path.join(enhancedDesktop, "icon.icns"),
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
console.log("Generated enhanced icons with a gold V badge; original assets preserved.");
