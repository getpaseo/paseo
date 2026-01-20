import { test, expect } from './fixtures';
import { createAgent, ensureHostSelected, gotoHome, setWorkingDirectory } from './helpers/app';
import { createTempGitRepo } from './helpers/workspace';
import type { Page } from '@playwright/test';

function addFakeMicrophone(page: Page) {
  return page.addInitScript(() => {
    const mic = {
      active: 0,
      getUserMediaCalls: 0,
      stopCalls: 0,
      lastRecorder: null as null | { state: string },
    };
    (window as any).__mic = mic;

    const ensureMediaDevices = () => {
      const nav = navigator as any;
      if (!nav.mediaDevices) {
        nav.mediaDevices = {};
      }
      if (typeof nav.mediaDevices.getUserMedia !== 'function') {
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
      }
    };

    ensureMediaDevices();

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
            data: new Blob(['paseo-e2e-audio'], { type: this.mimeType }),
          });
        } catch (err) {
          this.onerror?.(err);
        }
        this.dispatchEvent(new Event('stop'));
      }
    }

    (window as any).MediaRecorder = FakeMediaRecorder;
  });
}

test('dictation hotkeys do not trigger on background screens', async ({ page }) => {
  await addFakeMicrophone(page);

  const repo = await createTempGitRepo();
  try {
    await gotoHome(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgent(page, 'Respond with exactly: Hello');

    await expect(page).toHaveURL(/\/agent\//);

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

test('cancel stops mic even if recorder is already inactive', async ({ page }) => {
  await addFakeMicrophone(page);

  const repo = await createTempGitRepo();
  try {
    await gotoHome(page);
    await setWorkingDirectory(page, repo.path);
    await ensureHostSelected(page);
    await createAgent(page, 'Respond with exactly: Hello');

    await expect(page).toHaveURL(/\/agent\//);

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
