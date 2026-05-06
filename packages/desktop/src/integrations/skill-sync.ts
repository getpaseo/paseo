import { promises as fs } from "node:fs";
import path from "node:path";

export interface SkillSyncOptions {
  sourceDir: string;
  agentsDir: string;
  claudeDir: string;
  codexDir: string;
  skillNames: readonly string[];
  platform?: NodeJS.Platform;
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

async function listFilesRecursive(rootDir: string): Promise<string[]> {
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

async function ensureClaudeSkillLink(
  skillName: string,
  agentsDir: string,
  claudeDir: string,
  platform: NodeJS.Platform,
): Promise<number> {
  await fs.mkdir(claudeDir, { recursive: true });
  const target = path.join(agentsDir, skillName);
  const linkPath = path.join(claudeDir, skillName);

  // Always rebuild the link rather than diffing it. fs.rm with force: true is
  // a no-op when nothing is there, and matches existing install behavior.
  // On Windows, `fs.rm` does not follow junctions, so the agents-side content
  // is preserved.
  await fs.rm(linkPath, { recursive: true, force: true });

  if (platform === "win32") {
    try {
      // Junctions don't require Developer Mode / admin like regular symlinks do.
      await fs.symlink(target, linkPath, "junction");
      return 0;
    } catch {
      return await syncDirectoryFiles(target, linkPath);
    }
  }

  await fs.symlink(target, linkPath);
  return 0;
}

export async function syncSkills(options: SkillSyncOptions): Promise<SkillSyncResult> {
  const platform = options.platform ?? process.platform;
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

      changedFiles += await ensureClaudeSkillLink(
        skillName,
        options.agentsDir,
        options.claudeDir,
        platform,
      );

      changedFiles += await syncDirectoryFiles(
        bundleSkillDir,
        path.join(options.codexDir, skillName),
      );

      processedSkills++;
    } catch (error) {
      options.onSkillError?.(skillName, error);
    }
  }

  return { changedFiles, processedSkills };
}
