import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type PaseoHomeMetadataForkResult = {
  sourceHome: string;
  targetHome: string;
  agentFiles: number;
  agentBytes: number;
  projectFiles: number;
  projectBytes: number;
  copiedFiles: number;
  copiedBytes: number;
  skippedMissing: string[];
};

type CopyStats = {
  files: number;
  bytes: number;
  skippedMissing: string[];
};

export function resolvePaseoHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return path.resolve(value);
}

async function copyJsonTree(sourceDir: string, targetDir: string): Promise<CopyStats> {
  if (!existsSync(sourceDir)) {
    return { files: 0, bytes: 0, skippedMissing: [sourceDir] };
  }

  const stats: CopyStats = { files: 0, bytes: 0, skippedMissing: [] };
  const entries = await readdir(sourceDir, { withFileTypes: true });
  await mkdir(targetDir, { recursive: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      const nested = await copyJsonTree(sourcePath, targetPath);
      stats.files += nested.files;
      stats.bytes += nested.bytes;
      stats.skippedMissing.push(...nested.skippedMissing);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    const fileStat = await stat(sourcePath);
    stats.files += 1;
    stats.bytes += fileStat.size;
  }

  return stats;
}

async function copyProjectRegistryFiles(
  sourceHome: string,
  targetHome: string,
): Promise<CopyStats> {
  const stats: CopyStats = { files: 0, bytes: 0, skippedMissing: [] };
  const sourceProjectsDir = path.join(sourceHome, "projects");
  const targetProjectsDir = path.join(targetHome, "projects");
  await mkdir(targetProjectsDir, { recursive: true });

  for (const fileName of ["projects.json", "workspaces.json"]) {
    const sourcePath = path.join(sourceProjectsDir, fileName);
    const targetPath = path.join(targetProjectsDir, fileName);
    if (!existsSync(sourcePath)) {
      stats.skippedMissing.push(sourcePath);
      continue;
    }
    await copyFile(sourcePath, targetPath);
    const fileStat = await stat(sourcePath);
    stats.files += 1;
    stats.bytes += fileStat.size;
  }

  return stats;
}

export async function forkPaseoHomeMetadata(input: {
  sourceHome: string;
  targetHome: string;
}): Promise<PaseoHomeMetadataForkResult> {
  const sourceHome = resolvePaseoHomePath(input.sourceHome);
  const targetHome = resolvePaseoHomePath(input.targetHome);

  if (sourceHome === targetHome) {
    throw new Error("Refusing to fork Paseo metadata onto the same PASEO_HOME.");
  }

  await mkdir(targetHome, { recursive: true });

  // Reset only the copied metadata surface. In particular, do not copy or remove
  // worktrees here: forked workspace records should continue to point at the
  // original checkout/worktree paths from the source home.
  await rm(path.join(targetHome, "agents"), { recursive: true, force: true });
  await rm(path.join(targetHome, "projects", "projects.json"), { force: true });
  await rm(path.join(targetHome, "projects", "workspaces.json"), { force: true });

  const agents = await copyJsonTree(
    path.join(sourceHome, "agents"),
    path.join(targetHome, "agents"),
  );
  const projects = await copyProjectRegistryFiles(sourceHome, targetHome);

  return {
    sourceHome,
    targetHome,
    agentFiles: agents.files,
    agentBytes: agents.bytes,
    projectFiles: projects.files,
    projectBytes: projects.bytes,
    copiedFiles: agents.files + projects.files,
    copiedBytes: agents.bytes + projects.bytes,
    skippedMissing: [...agents.skippedMissing, ...projects.skippedMissing],
  };
}
