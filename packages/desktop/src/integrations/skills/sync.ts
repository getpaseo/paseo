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
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(path.relative(rootDir, full));
      }
    }
  }
  await walk(rootDir);
  return out;
}

async function syncDirectoryFiles(srcDir: string, dstDir: string): Promise<number> {
  const files = await listFilesRecursive(srcDir);
  let changed = 0;
  for (const rel of files) {
    if (await writeFileIfChanged(path.join(srcDir, rel), path.join(dstDir, rel))) {
      changed++;
    }
  }
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
