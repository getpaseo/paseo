import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures';
import {
  createAgentWithConfig,
  waitForPermissionPrompt,
  allowPermission,
  denyPermission,
  waitForAgentFinishUI,
  getToolCallCount,
} from './helpers/app';
import { createTempGitRepo } from './helpers/workspace';

const FILE_CONTENT = 'Hello from permission test';

test.describe('permission prompts', () => {
  test('allow permission creates the file', async ({ page }) => {
    const repo = await createTempGitRepo();
    const uniqueFilename = `test-allow-${Date.now()}.txt`;
    const filePath = path.join(repo.path, uniqueFilename);
    const prompt = `Create a file named "${uniqueFilename}" with the content "${FILE_CONTENT}". Do not add any extra content.`;

    try {
      await createAgentWithConfig(page, {
        directory: repo.path,
        model: 'haiku',
        mode: 'Always Ask',
        prompt,
      });

      await waitForPermissionPrompt(page, 30000);

      // Check tool call count before allowing permission
      // In "Always Ask" mode, we should see the permission prompt badge
      const toolCallCountBefore = await getToolCallCount(page);
      expect(toolCallCountBefore).toBe(1);

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
    const prompt = `Create a file named "${uniqueFilename}" with the content "${FILE_CONTENT}". Do not add any extra content.`;

    try {
      await createAgentWithConfig(page, {
        directory: repo.path,
        model: 'haiku',
        mode: 'Always Ask',
        prompt,
      });

      await waitForPermissionPrompt(page, 30000);
      await denyPermission(page);

      // After denying permission, wait for the agent to show the permission denied result
      // The agent might stay in running state but should show a tool call result
      await page.waitForTimeout(3000); // Give time for the denial to be processed

      expect(existsSync(filePath)).toBe(false);

      // Verify exactly two tool calls are visible (permission prompt + actual tool call)
      const toolCallCount = await getToolCallCount(page);
      expect(toolCallCount).toBe(2);
    } finally {
      await repo.cleanup();
    }
  });
});
