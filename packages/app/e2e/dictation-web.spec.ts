import { test, expect } from './fixtures';
import { createAgent, ensureHostSelected, gotoHome, setWorkingDirectory } from './helpers/app';
import { createTempGitRepo } from './helpers/workspace';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function addFakeMicrophone(page: Page) {
  const fixturePath = path.resolve(__dirname, 'fixtures', 'recording.webm');
  const base64Audio = (await readFile(fixturePath)).toString('base64');
  const mimeType = 'audio/webm;codecs=opus';

  return page.addInitScript(({ base64Audio, mimeType }) => {
    const mic = {
      active: 0,
      getUserMediaCalls: 0,
      stopCalls: 0,
      lastRecorder: null as null | { state: string },
    };
    (window as any).__mic = mic;

    (window as any).isSecureContext = true;

    const nav = navigator as any;
    if (!nav.mediaDevices) {
      nav.mediaDevices = {};
    }
    nav.mediaDevices.getUserMedia = async () => {
      mic.getUserMediaCalls += 1;
      mic.active += 1;
      const track = {
        stop: () => {
          mic.stopCalls += 1;
          mic.active = Math.max(0, mic.active - 1);
        },
      };
      return {
        getTracks: () => [track],
      };
    };

    const blobFromBase64 = (base64: string, mimeType: string): Blob => {
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return new Blob([bytes], { type: mimeType });
    };

    class FakeMediaRecorder extends EventTarget {
      public static isTypeSupported() {
        return true;
      }

      public state: 'inactive' | 'recording' = 'inactive';
      public mimeType: string;
      public ondataavailable: ((event: { data: Blob }) => void) | null = null;
      public onerror: ((event: unknown) => void) | null = null;

      constructor(_stream: unknown, options?: MediaRecorderOptions) {
        super();
        this.mimeType = options?.mimeType ?? 'audio/webm';
        mic.lastRecorder = this;
      }

      public start() {
        this.state = 'recording';
      }

      public stop() {
        if (this.state !== 'recording') {
          throw new Error('Not recording');
        }
        this.state = 'inactive';
        try {
          this.ondataavailable?.({
            data: blobFromBase64(base64Audio, mimeType),
          });
        } catch (err) {
          this.onerror?.(err);
        }
        this.dispatchEvent(new Event('stop'));
      }
    }

    (window as any).MediaRecorder = FakeMediaRecorder;
  }, { base64Audio, mimeType });
}

test('dictation hotkeys do not trigger on background screens', async ({ page }) => {
  await addFakeMicrophone(page);

  const repo = await createTempGitRepo();
  try {
    await gotoHome(page);
    await ensureHostSelected(page);
    await setWorkingDirectory(page, repo.path);
    await createAgent(page, 'Respond with exactly: Hello');

    await expect(page).toHaveURL(/\/agent\//);
    await expect(page.getByRole('textbox', { name: 'Message agent...' })).toBeEditable();

    await page.keyboard.press('Control+d');
    await page.waitForTimeout(200);

    const calls = await page.evaluate(() => (window as any).__mic.getUserMediaCalls as number);
    const active = await page.evaluate(() => (window as any).__mic.active as number);

    expect(calls).toBe(1);
    expect(active).toBe(1);

    await page.keyboard.press('Escape');
    await expect
      .poll(async () => page.evaluate(() => (window as any).__mic.active as number))
      .toBe(0);
  } finally {
    await repo.cleanup();
  }
});

test('dictation transcribes fixture via real STT', async ({ page }) => {
  await addFakeMicrophone(page);

  const repo = await createTempGitRepo();
  try {
    await gotoHome(page);
    await ensureHostSelected(page);
    await setWorkingDirectory(page, repo.path);
    await createAgent(page, 'Respond with exactly: Hello');

    await expect(page).toHaveURL(/\/agent\//);
    await expect(page.getByRole('textbox', { name: 'Message agent...' })).toBeEditable();

    await page.keyboard.press('Control+d');
    await expect
      .poll(async () => page.evaluate(() => (window as any).__mic.active as number))
      .toBe(1);

    await page.keyboard.press('Control+d');

    const transcriptLocator = page.getByText(/voice note/i);
    await expect(transcriptLocator).toBeVisible({ timeout: 60_000 });
  } finally {
    await repo.cleanup();
  }
});

test('cancel stops mic even if recorder is already inactive', async ({ page }) => {
  await addFakeMicrophone(page);

  const repo = await createTempGitRepo();
  try {
    await gotoHome(page);
    await ensureHostSelected(page);
    await setWorkingDirectory(page, repo.path);
    await createAgent(page, 'Respond with exactly: Hello');

    await expect(page).toHaveURL(/\/agent\//);
    await expect(page.getByRole('textbox', { name: 'Message agent...' })).toBeEditable();

    await page.keyboard.press('Control+d');
    await expect
      .poll(async () => page.evaluate(() => (window as any).__mic.active as number))
      .toBe(1);

    await page.evaluate(() => {
      const mic = (window as any).__mic as { lastRecorder: null | { state: string } };
      if (mic.lastRecorder) {
        mic.lastRecorder.state = 'inactive';
      }
    });

    await page.keyboard.press('Escape');
    await expect
      .poll(async () => page.evaluate(() => (window as any).__mic.active as number))
      .toBe(0);
  } finally {
    await repo.cleanup();
  }
});

test('dictation confirm+send does not dispatch after navigating away', async ({ page }) => {
  await addFakeMicrophone(page);

  const repo = await createTempGitRepo();
  try {
    await gotoHome(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgent(page, 'Respond with exactly: Hello');

    await expect(page).toHaveURL(/\/agent($|\/)/);
    await expect(page.getByRole('textbox', { name: 'Message agent...' })).toBeEditable();

    await page.keyboard.press('Control+d');
    await expect
      .poll(async () => page.evaluate(() => (window as any).__mic.active as number))
      .toBe(1);

    await page.keyboard.press('Control+d');

    const newAgentButton = page.getByTestId('sidebar-new-agent');
    await expect(newAgentButton).toBeVisible();
    await newAgentButton.click();
    await expect(page).toHaveURL(/\/agent\/?$/);

    await page.waitForTimeout(10_000);

    const agentEntry = page.getByText(repo.path).first();
    await expect(agentEntry).toBeVisible();
    await agentEntry.click();
    await expect(page).toHaveURL(/\/agent($|\/)/);

    await expect(page.getByText(/voice note/i)).not.toBeVisible();
  } finally {
    await repo.cleanup();
  }
});
