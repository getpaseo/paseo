import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareDocumentFonts, documentFontSubstitutions } from "./document-fonts.js";
import { resolveWorkspaceDocumentPath } from "./workspace-file-path.js";
const execute = promisify(execFile);
let queue: Promise<unknown> = Promise.resolve();

export async function createDocumentPreview(
  home: string,
  cwd: string,
  requested: string,
): Promise<{ cwd: string; path: string }> {
  const operation = queue.catch(() => {}).then(() => convert(home, cwd, requested));
  queue = operation;
  return operation;
}
async function convert(home: string, cwd: string, requested: string) {
  const source = await resolveWorkspaceDocumentPath(cwd, requested);
  if (!/\.(doc|docx)$/i.test(source)) throw new Error("Only DOC and DOCX conversion is supported");
  if ((await stat(source)).size > 50 * 1024 * 1024)
    throw new Error("Word preview exceeds the 50 MiB limit");
  // Conversion is deliberately enabled only with macOS's network-denying sandbox.
  // Other hosts retain save / external opening until an equivalent sandbox is configured.
  if (process.platform !== "darwin")
    throw new Error(
      "Word conversion currently requires a macOS host. Save or open the original document instead.",
    );
  const office =
    process.env.PASEO_LIBREOFFICE_PATH || "/Applications/LibreOffice.app/Contents/MacOS/soffice";
  try {
    await access(office, constants.X_OK);
  } catch {
    throw new Error("Install LibreOffice on the host to preview Word documents");
  }
  const fonts = await prepareDocumentFonts();
  const bytes = await readFile(source);
  const officeStat = await stat(office);
  const key = createHash("sha256")
    .update(bytes)
    .update(`paseo-word-preview-v2:${officeStat.size}:${officeStat.mtimeMs}:${fonts}`)
    .update(documentFontSubstitutions())
    .digest("hex");
  const root = path.join(home, "document-previews");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const cached = path.join(root, `${key}.pdf`);
  await prunePreviews(root, cached);
  try {
    await access(cached);
    await utimes(cached, new Date(), new Date());
    return { cwd: root, path: path.basename(cached) };
  } catch {}
  const work = await mkdtemp(path.join(root, ".convert-"));
  try {
    const profile = path.join(work, "profile");
    await mkdir(path.join(profile, "user"), { recursive: true });
    await writeFile(
      path.join(profile, "user/registrymodifications.xcu"),
      '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Common/Security/Update"><prop oor:name="LinkUpdateMode" oor:op="fuse"><value>0</value></prop></item>' +
        documentFontSubstitutions() +
        "</oor:items>",
    );
    const input = path.join(work, `document${path.extname(source).toLowerCase()}`);
    await writeFile(input, bytes, { mode: 0o600 });
    // A private profile avoids any connection to an existing LibreOffice instance.
    const sandbox =
      '(version 1)(allow default)(deny network*)(allow network-bind network-outbound (subpath "/private/tmp"))(deny file-write*)(allow file-write* (subpath ' +
      JSON.stringify(work) +
      ')(subpath "/private/tmp")(subpath "/private/var/folders"))';
    const conversion = await execute(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        sandbox,
        office,
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        "--headless",
        "--norestore",
        "--nodefault",
        "--nolockcheck",
        "--convert-to",
        "pdf:writer_pdf_Export",
        "--outdir",
        work,
        input,
      ],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    const output = path.join(work, "document.pdf");
    const pdf = await readFile(output).catch(() => {
      throw new Error(`Word conversion produced no PDF: ${conversion.stdout} ${conversion.stderr}`);
    });
    if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-")))
      throw new Error("LibreOffice did not produce a valid PDF");
    if (pdf.length > 50 * 1024 * 1024)
      throw new Error("Converted preview exceeds the 50 MiB limit");
    await rename(output, cached);
    return { cwd: root, path: path.basename(cached) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function prunePreviews(root: string, keep: string) {
  const files = await Promise.all(
    (await readdir(root))
      .filter((name) => /^[a-f0-9]{64}\.pdf$/.test(name))
      .map(async (name) => {
        const file = path.join(root, name);
        const info = await stat(file);
        return { file, size: info.size, modified: info.mtimeMs };
      }),
  );
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const entry of files.sort((a, b) => a.modified - b.modified)) {
    if (entry.file === keep) continue;
    if (Date.now() - entry.modified > 7 * 86400_000 || total > 450 * 1024 * 1024) {
      await rm(entry.file, { force: true });
      total -= entry.size;
    }
  }
}
