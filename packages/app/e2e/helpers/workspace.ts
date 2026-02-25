import { execSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type TempRepo = {
  path: string;
  cleanup: () => Promise<void>;
};

export const createTempGitRepo = async (
  prefix = 'paseo-e2e-',
  options?: { withRemote?: boolean }
): Promise<TempRepo> => {
  // Keep E2E repo paths short so terminal prompt + typed commands stay visible without zsh clipping.
  const tempRoot = process.platform === 'win32' ? tmpdir() : '/tmp';
  const repoPath = await mkdtemp(path.join(tempRoot, prefix));
  const withRemote = options?.withRemote ?? false;

  execSync('git init -b main', { cwd: repoPath, stdio: 'ignore' });
  execSync('git config user.email "e2e@paseo.test"', { cwd: repoPath, stdio: 'ignore' });
  execSync('git config user.name "Paseo E2E"', { cwd: repoPath, stdio: 'ignore' });
  await writeFile(path.join(repoPath, 'README.md'), '# Temp Repo\n');
  execSync('git add README.md', { cwd: repoPath, stdio: 'ignore' });
  execSync('git commit -m "Initial commit"', { cwd: repoPath, stdio: 'ignore' });

  if (withRemote) {
    // Deterministic local remote to avoid relying on external auth/network in e2e.
    const remoteDir = path.join(repoPath, 'remote.git');
    await mkdir(remoteDir, { recursive: true });
    execSync(`git init --bare -b main ${remoteDir}`, { cwd: repoPath, stdio: 'ignore' });
    execSync(`git remote add origin ${remoteDir}`, { cwd: repoPath, stdio: 'ignore' });
    execSync('git push -u origin main', { cwd: repoPath, stdio: 'ignore' });
  }

  return {
    path: repoPath,
    cleanup: async () => {
      await rm(repoPath, { recursive: true, force: true });
    },
  };
};
