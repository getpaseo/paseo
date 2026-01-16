import { execSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type TempRepo = {
  path: string;
  cleanup: () => Promise<void>;
};

export const createTempGitRepo = async (prefix = 'paseo-e2e-'): Promise<TempRepo> => {
  const repoPath = await mkdtemp(path.join(tmpdir(), prefix));

  execSync('git init', { cwd: repoPath, stdio: 'ignore' });
  await writeFile(path.join(repoPath, 'README.md'), '# Temp Repo\n');
  execSync('git add README.md', { cwd: repoPath, stdio: 'ignore' });
  execSync('git commit -m "Initial commit"', { cwd: repoPath, stdio: 'ignore' });

  return {
    path: repoPath,
    cleanup: async () => {
      await rm(repoPath, { recursive: true, force: true });
    },
  };
};
