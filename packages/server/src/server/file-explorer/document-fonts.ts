import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const manifestSchema = z.array(
  z.object({
    file: z.string().regex(/^[A-Za-z0-9-]+\.(otf|ttf|txt)$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
);
const execute = promisify(execFile);
let prepared: Promise<string> | undefined;

// Native macOS LibreOffice reads CoreText's user fonts, not profile/user/fonts.
// Keep our licensed files in a separate folder; never replace the user's fonts.
export function prepareDocumentFonts(): Promise<string> {
  prepared ??= (async () => {
    const sourceDir =
      process.env.PASEO_DOCUMENT_FONTS_PATH ||
      fileURLToPath(new URL("../../../assets/document-fonts/", import.meta.url));
    const targetDir = path.join(os.homedir(), "Library/Fonts/PaseoEnhanced");
    const fingerprint = await installDocumentFonts(sourceDir, targetDir);
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(path.join(sourceDir, "manifest.json"), "utf8")),
    );
    const fonts = manifest
      .filter((entry) => /\.(otf|ttf)$/.test(entry.file))
      .map((entry) => path.join(targetDir, `${entry.sha256.slice(0, 12)}-${entry.file}`));
    await execute(path.join(sourceDir, "register-fonts"), fonts, {
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    });
    return fingerprint;
  })().catch((error: unknown) => {
    prepared = undefined;
    throw error;
  });
  return prepared;
}

export async function installDocumentFonts(sourceDir: string, targetDir: string): Promise<string> {
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(path.join(sourceDir, "manifest.json"), "utf8")),
  );
  const fingerprint = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  for (const entry of manifest) {
    const bytes = await readFile(path.join(sourceDir, entry.file));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new Error(`Bundled document font checksum mismatch: ${entry.file}`);
    }
    const target = path.join(targetDir, `${entry.sha256.slice(0, 12)}-${entry.file}`);
    const existing = await readFile(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (existing) {
      if (!existing.equals(bytes)) throw new Error(`Document font file conflicts: ${entry.file}`);
      continue;
    }
    const temporary = path.join(targetDir, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { mode: 0o644, flag: "wx" });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return fingerprint;
}

// Normalize aliases of the bundled families in our private conversion profile.
// Common Office fonts are replaced only when missing; source formatting stays intact.
export function documentFontSubstitutions(): string {
  const pairs = [
    // Native LibreOffice uses the localized family name on this macOS locale.
    ["Source Han Sans SC", "思源黑体"],
    ["SourceHanSansSC-Regular", "思源黑体"],
    ["Source Han Serif SC", "思源宋体"],
    ["SourceHanSerifSC-Regular", "思源宋体"],
    ["LXGW WenKai", "霞鹜文楷"],
    ["LXGWWenKai-Regular", "霞鹜文楷"],
    ["SimSun", "思源宋体"],
    ["宋体", "思源宋体"],
    ["NSimSun", "思源宋体"],
    ["SimHei", "思源黑体"],
    ["黑体", "思源黑体"],
    ["Microsoft YaHei", "思源黑体"],
    ["微软雅黑", "思源黑体"],
    ["KaiTi", "霞鹜文楷"],
    ["楷体", "霞鹜文楷"],
  ];
  const nodes = pairs.map(
    ([font, replacement], index) =>
      `<node oor:name="paseo${index}" oor:op="replace"><prop oor:name="ReplaceFont" oor:op="fuse"><value>${font}</value></prop><prop oor:name="SubstituteFont" oor:op="fuse"><value>${replacement}</value></prop><prop oor:name="Always" oor:op="fuse"><value>${index < 6}</value></prop><prop oor:name="OnScreenOnly" oor:op="fuse"><value>false</value></prop></node>`,
  );
  return `<item oor:path="/org.openoffice.Office.Common/Font/Substitution"><prop oor:name="Replacement" oor:op="fuse"><value>true</value></prop></item><item oor:path="/org.openoffice.Office.Common/Font/Substitution/FontPairs">${nodes.join("")}</item>`;
}
