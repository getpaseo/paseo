import { execSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type TempRepo = {
  path: string;
  owner?: string;
  name?: string;
  cleanup: () => Promise<void>;
};

export const createTempGitRepo = async (
  prefix = 'paseo-e2e-',
  options?: { withRemote?: boolean }
): Promise<TempRepo> => {
  const repoPath = await mkdtemp(path.join(tmpdir(), prefix));
  const repoName = `paseo-e2e-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  let owner: string | undefined;
  const withRemote = options?.withRemote ?? false;

  execSync('git init -b main', { cwd: repoPath, stdio: 'ignore' });
  execSync('git config user.email "e2e@paseo.test"', { cwd: repoPath, stdio: 'ignore' });
  execSync('git config user.name "Paseo E2E"', { cwd: repoPath, stdio: 'ignore' });
  await writeFile(path.join(repoPath, 'README.md'), '# Temp Repo\n');
  execSync('git add README.md', { cwd: repoPath, stdio: 'ignore' });
  execSync('git commit -m "Initial commit"', { cwd: repoPath, stdio: 'ignore' });

  if (withRemote) {
    try {
      owner = execSync('gh api user -q .login', { encoding: 'utf8' }).trim();
      execSync(
        `gh repo create ${repoName} --private --confirm --source=. --remote=origin --push`,
        {
          cwd: repoPath,
          stdio: 'ignore',
        }
      );
    } catch (error) {
      await rm(repoPath, { recursive: true, force: true });
      throw error;
    }
  }

  return {
    path: repoPath,
    owner,
    name: repoName,
    cleanup: async () => {
      if (owner && withRemote) {
        try {
          execSync(`gh repo delete ${owner}/${repoName} --yes`, { stdio: 'ignore' });
        } catch {
          // Best-effort cleanup
        }
      }
      await rm(repoPath, { recursive: true, force: true });
    },
  };
};
