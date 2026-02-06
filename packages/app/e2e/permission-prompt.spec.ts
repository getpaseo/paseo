import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures';
import {
  createAgentWithConfig,
  waitForPermissionPrompt,
  allowPermission,
  denyPermission,
} from './helpers/app';
import { createTempGitRepo } from './helpers/workspace';

const FILE_CONTENT = 'Hello from permission test';

function buildWriteCommand(filePath: string): string {
  return `bash -lc 'sleep 2; printf "${FILE_CONTENT}" > "${filePath}"'`;
}

test.describe('permission prompts', () => {
  test('allow permission creates the file', async ({ page }) => {
    const repo = await createTempGitRepo();
    const uniqueFilename = `test-allow-${Date.now()}.txt`;
    const filePath = path.join(repo.path, uniqueFilename);
    const shellCommand = buildWriteCommand(filePath);
    const prompt = [
      `Use your shell tool to run exactly this command:`,
      shellCommand,
      `Do not write outside this exact path.`,
    ].join(' ');

    try {
      await createAgentWithConfig(page, {
        directory: repo.path,
        model: 'haiku',
        mode: 'Always Ask',
        prompt,
      });

      await waitForPermissionPrompt(page, 30000);

      await allowPermission(page);

      // Wait for file to be created
      await expect
        .poll(() => existsSync(filePath), {
          message: `File ${filePath} should exist after allowing permission`,
          timeout: 30000,
        })
        .toBe(true);

      // After allowing, the file should be created successfully
      // The tool call count might still be 1 if the UI updates quickly
      const fileContent = await readFile(filePath, 'utf-8');
      expect(fileContent.trim()).toBe(FILE_CONTENT);
    } finally {
      await repo.cleanup();
    }
  });

  test('deny permission does not create the file', async ({ page }) => {
    const repo = await createTempGitRepo();
    const uniqueFilename = `test-deny-${Date.now()}.txt`;
    const filePath = path.join(repo.path, uniqueFilename);
    const shellCommand = buildWriteCommand(filePath);
    const prompt = [
      `Use your shell tool to run exactly this command:`,
      shellCommand,
      `Do not write outside this exact path.`,
    ].join(' ');

    try {
      await createAgentWithConfig(page, {
        directory: repo.path,
        model: 'haiku',
        mode: 'Always Ask',
        prompt,
      });

      await waitForPermissionPrompt(page, 30000);

      await denyPermission(page);

      await expect(page.getByText(/denied by the user|permission\/authorization check/i)).toBeVisible({
        timeout: 30_000,
      });

      expect(existsSync(filePath)).toBe(false);

    } finally {
      await repo.cleanup();
    }
  });
});
