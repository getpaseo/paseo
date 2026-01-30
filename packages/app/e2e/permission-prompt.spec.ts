import { existsSync } from 'node:fs';
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
      await allowPermission(page);

      // Wait for file to be created
      await expect
        .poll(() => existsSync(filePath), {
          message: `File ${filePath} should exist after allowing permission`,
          timeout: 10000,
        })
        .toBe(true);

      // Verify exactly one tool call is visible (no duplicate permission badge)
      const toolCallCount = await getToolCallCount(page);
      expect(toolCallCount).toBe(1);
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
      await waitForAgentFinishUI(page);

      expect(existsSync(filePath)).toBe(false);

      // Verify exactly one tool call is visible (no duplicate permission badge)
      const toolCallCount = await getToolCallCount(page);
      expect(toolCallCount).toBe(1);
    } finally {
      await repo.cleanup();
    }
  });
});
