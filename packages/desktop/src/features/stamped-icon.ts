import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const STAMP_CACHE_VERSION = "v2";

export const MONOSPACE_FONT_CANDIDATES = [
  "Menlo-Bold",
  "SFMono-Bold",
  "Consolas-Bold",
  "DejaVu-Sans-Mono-Bold",
  "Liberation-Mono-Bold",
  "Courier-New-Bold",
  "Courier-Bold",
  "Courier",
] as const;

export interface StampGeometry {
  label: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  r: number;
  pointsize: number;
  offsetY: number;
}

export function resolveMonospaceFont(fontsListOutput: string): string {
  for (const candidate of MONOSPACE_FONT_CANDIDATES) {
    const regex = new RegExp(`^\\s*Font:\\s*${candidate}\\b`, "im");
    if (regex.test(fontsListOutput)) {
      return candidate;
    }
  }
  return "Courier";
}

export function computeStampGeometry(
  width: number,
  height: number,
  rawLabel: string,
): StampGeometry {
  const label = rawLabel.trim().toLowerCase();
  const ph = Math.max(24, Math.round(height * 0.1));
  const maxPointSize = Math.round(ph * 1.03);
  const minPointSize = 12;
  const pointsize = Math.max(
    minPointSize,
    Math.min(maxPointSize, Math.round((width * 0.8) / Math.max(1, label.length * 0.6))),
  );
  const textWidth = label.length * (pointsize * 0.6);
  const paddingX = Math.round(ph * 0.7);
  const pw = Math.min(
    Math.round(width * 0.88),
    Math.max(Math.round(width * 0.35), Math.round(textWidth + paddingX * 2)),
  );
  const centerY = Math.round(height * 0.81);
  const y1 = Math.round(centerY - ph / 2);
  const y2 = Math.round(centerY + ph / 2);
  const x1 = Math.round((width - pw) / 2);
  const x2 = Math.round((width + pw) / 2);
  const r = Math.round(ph / 2);
  const offsetY = Math.round(centerY - height / 2);

  return {
    label,
    x1,
    y1,
    x2,
    y2,
    r,
    pointsize,
    offsetY,
  };
}

export function buildImageMagickArgs(
  inputPath: string,
  outputPath: string,
  geometry: StampGeometry,
  font: string,
  width: number,
  height: number,
): string[] {
  return [
    inputPath,
    "(",
    "-clone",
    "0",
    "-alpha",
    "extract",
    ")",
    "(",
    "-size",
    `${width}x${height}`,
    "xc:none",
    "-fill",
    "rgba(10,12,18,0.88)",
    "-draw",
    `roundrectangle ${geometry.x1},${geometry.y1} ${geometry.x2},${geometry.y2} ${geometry.r},${geometry.r}`,
    "-gravity",
    "center",
    "-font",
    font,
    "-pointsize",
    String(geometry.pointsize),
    "-fill",
    "#f0f0f5",
    "-annotate",
    `+0+${geometry.offsetY}`,
    geometry.label,
    ")",
    "(",
    "-clone",
    "2",
    "-clone",
    "1",
    "-compose",
    "DstIn",
    "-composite",
    ")",
    "-delete",
    "1,2",
    "-compose",
    "Over",
    "-composite",
    outputPath,
  ];
}

let cachedMonospaceFont: string | null = null;

async function detectMonospaceFont(magickBin: string): Promise<string> {
  if (cachedMonospaceFont) {
    return cachedMonospaceFont;
  }
  try {
    const { stdout } = await execFileAsync(magickBin, ["-list", "font"], {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
    });
    cachedMonospaceFont = resolveMonospaceFont(stdout);
  } catch {
    cachedMonospaceFont = "Courier";
  }
  return cachedMonospaceFont;
}

function sanitizeLabelForFilename(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function getImageDimensions(
  magickBin: string,
  filePath: string,
): Promise<{ width: number; height: number } | null> {
  try {
    const { stdout } = await execFileAsync(magickBin, ["identify", "-format", "%wx%h", filePath], {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
    });
    const match = stdout.trim().match(/^(\d+)x(\d+)$/);
    if (match) {
      return { width: Number.parseInt(match[1], 10), height: Number.parseInt(match[2], 10) };
    }
  } catch {
    // fallback if identify fails
  }
  return null;
}

export async function getStampedIconPath(options: {
  baseIconPath: string;
  label: string;
  cacheDir: string;
}): Promise<string | null> {
  const { baseIconPath, label, cacheDir } = options;
  if (!label || !existsSync(baseIconPath)) {
    return null;
  }

  const safeLabel = sanitizeLabelForFilename(label) || "dev";
  const baseName = path.basename(baseIconPath, path.extname(baseIconPath));
  const outputPath = path.join(
    cacheDir,
    `icon-stamp-${STAMP_CACHE_VERSION}-${baseName}-${safeLabel}.png`,
  );

  if (existsSync(outputPath)) {
    return outputPath;
  }

  const magickBin = process.platform === "win32" ? "magick.exe" : "magick";
  try {
    const dimensions = (await getImageDimensions(magickBin, baseIconPath)) ?? {
      width: 512,
      height: 512,
    };
    const font = await detectMonospaceFont(magickBin);
    const geometry = computeStampGeometry(dimensions.width, dimensions.height, label);

    await fs.mkdir(cacheDir, { recursive: true });
    const args = buildImageMagickArgs(
      baseIconPath,
      outputPath,
      geometry,
      font,
      dimensions.width,
      dimensions.height,
    );

    await execFileAsync(magickBin, args, {
      timeout: 6000,
      windowsHide: true,
    });

    if (existsSync(outputPath)) {
      return outputPath;
    }
  } catch {
    // Graceful degradation: dev icon stamping is optional and fails silently to base icon.
  }

  return null;
}

export async function resolveAppIconPath(options: {
  isPackaged: boolean;
  baseIconPath: string | null;
  devLabel: string | null;
  cacheDir: string;
}): Promise<string | null> {
  const { isPackaged, baseIconPath, devLabel, cacheDir } = options;
  if (!baseIconPath) {
    return null;
  }

  if (isPackaged || !devLabel) {
    return baseIconPath;
  }

  const stamped = await getStampedIconPath({
    baseIconPath,
    label: devLabel,
    cacheDir,
  });

  return stamped ?? baseIconPath;
}
