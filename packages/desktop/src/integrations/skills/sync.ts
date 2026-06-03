import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface SkillSyncOptions {
  sourceDir: string;
  agentsDir: string;
  claudeDir: string;
  codexDir: string;
  skillNames: readonly string[];
  onSkillError?: (skillName: string, error: unknown) => void;
}

export interface SkillSyncResult {
  changedFiles: number;
  processedSkills: number;
}

const MANAGED_FILES_MANIFEST = ".paseo-managed-files.json";

interface ManagedFilesManifest {
  version: 1;
  files: Record<string, string>;
}

async function writeFileIfChanged(srcPath: string, dstPath: string): Promise<boolean> {
  const src = await fs.readFile(srcPath);
  const dst = await fs.readFile(dstPath).catch(() => null);
  if (dst && src.equals(dst)) return false;
  await fs.mkdir(path.dirname(dstPath), { recursive: true });
  await fs.writeFile(dstPath, src);
  return true;
}

export async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full);
      if (rel === MANAGED_FILES_MANIFEST) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  await walk(rootDir);
  return out;
}

async function readManagedFilesManifest(dstDir: string): Promise<ManagedFilesManifest | null> {
  const raw = await fs
    .readFile(path.join(dstDir, MANAGED_FILES_MANIFEST), "utf-8")
    .catch(() => null);
  if (!raw) return null;
  const parsed = safeParseJson(raw) as Partial<ManagedFilesManifest> | null;
  if (!parsed) return null;
  if (parsed.version !== 1 || typeof parsed.files !== "object" || parsed.files === null)
    return null;
  return { version: 1, files: parsed.files as Record<string, string> };
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

async function writeManifestIfChanged(
  dstDir: string,
  files: Record<string, string>,
): Promise<boolean> {
  const manifest: ManagedFilesManifest = { version: 1, files };
  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = path.join(dstDir, MANAGED_FILES_MANIFEST);
  const current = await fs.readFile(manifestPath, "utf-8").catch(() => null);
  if (current === next) return false;
  await fs.mkdir(dstDir, { recursive: true });
  await fs.writeFile(manifestPath, next);
  return true;
}

async function pruneEmptyParentDirs(rootDir: string, rels: readonly string[]): Promise<void> {
  const dirs = new Set<string>();
  for (const rel of rels) {
    let dir = path.dirname(rel);
    while (dir !== ".") {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }
  const deepestFirst = [...dirs].sort(
    (a, b) => b.split(path.sep).length - a.split(path.sep).length,
  );
  for (const rel of deepestFirst) {
    await fs.rmdir(path.join(rootDir, rel)).catch(() => {});
  }
}

async function syncDirectoryFiles(srcDir: string, dstDir: string): Promise<number> {
  const files = await listFilesRecursive(srcDir);
  const srcFileSet = new Set(files);
  const srcHashes: Record<string, string> = {};
  for (const rel of files) {
    srcHashes[rel] = await hashFile(path.join(srcDir, rel));
  }
  const previousManifest = await readManagedFilesManifest(dstDir);
  let changed = 0;
  for (const rel of files) {
    if (await writeFileIfChanged(path.join(srcDir, rel), path.join(dstDir, rel))) {
      changed++;
    }
  }

  const deletedRels: string[] = [];
  for (const [rel, previousHash] of Object.entries(previousManifest?.files ?? {})) {
    if (srcFileSet.has(rel)) continue;
    const dstPath = path.join(dstDir, rel);
    const currentHash = await hashFile(dstPath).catch(() => null);
    if (currentHash !== previousHash) continue;
    await fs.rm(dstPath, { force: true });
    deletedRels.push(rel);
    changed++;
  }
  await pruneEmptyParentDirs(dstDir, deletedRels);
  if (await writeManifestIfChanged(dstDir, srcHashes)) changed++;
  return changed;
}

export interface RemoveSkillTargets {
  agentsDir: string;
  claudeDir: string;
  codexDir: string;
}

export async function removeSkill(skillName: string, targets: RemoveSkillTargets): Promise<void> {
  const paths = [
    path.join(targets.agentsDir, skillName),
    path.join(targets.claudeDir, skillName),
    path.join(targets.codexDir, skillName),
  ];
  for (const p of paths) {
    await fs.rm(p, { recursive: true, force: true });
  }
}

export async function syncSkills(options: SkillSyncOptions): Promise<SkillSyncResult> {
  let changedFiles = 0;
  let processedSkills = 0;

  for (const skillName of options.skillNames) {
    const bundleSkillDir = path.join(options.sourceDir, skillName);

    const bundleStat = await fs.stat(bundleSkillDir).catch(() => null);
    if (!bundleStat?.isDirectory()) continue;

    try {
      changedFiles += await syncDirectoryFiles(
        bundleSkillDir,
        path.join(options.agentsDir, skillName),
      );

      changedFiles += await syncDirectoryFiles(
        bundleSkillDir,
        path.join(options.claudeDir, skillName),
      );

      changedFiles += await syncDirectoryFiles(
        bundleSkillDir,
        path.join(options.codexDir, skillName),
      );

      processedSkills++;
    } catch (error) {
      if (!options.onSkillError) throw error;
      options.onSkillError(skillName, error);
    }
  }

  return { changedFiles, processedSkills };
}
