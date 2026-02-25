import { test, expect } from './fixtures';
import { createAgent, ensureHostSelected, gotoHome, setWorkingDirectory } from './helpers/app';
import { createTempGitRepo } from './helpers/workspace';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function addFakeMicrophone(page: Page) {
  const fixturePath = path.resolve(__dirname, 'fixtures', 'recording.wav');
  const base64Audio = (await readFile(fixturePath)).toString('base64');
  const mimeType = 'audio/wav';

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

    const AudioContextCtor =
      (window as any).AudioContext ?? (window as any).webkitAudioContext;
    if (AudioContextCtor?.prototype?.createMediaStreamSource) {
      const nativeCreateMediaStreamSource =
        AudioContextCtor.prototype.createMediaStreamSource;
      AudioContextCtor.prototype.createMediaStreamSource =
        function patchedCreateMediaStreamSource(stream: unknown) {
          const isFakeStream =
            !!stream &&
            typeof (stream as { getTracks?: unknown }).getTracks === 'function' &&
            typeof (stream as { id?: unknown }).id === 'undefined';
          if (isFakeStream) {
            throw new Error('Force recorder fallback for fake microphone stream');
          }
          return nativeCreateMediaStreamSource.call(this, stream);
        };
    }

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

    const initialCopyMessageCount = await page
      .getByRole('button', { name: 'Copy message' })
      .count();

    await page.keyboard.press('Control+d');
    await expect
      .poll(async () => page.evaluate(() => (window as any).__mic.active as number))
      .toBe(0);

    await expect
      .poll(
        async () => page.getByRole('button', { name: 'Copy message' }).count(),
        { timeout: 60_000 }
      )
      .toBeGreaterThan(initialCopyMessageCount);
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
    const match = page.url().match(/\/h\/([^/]+)\/agent\/([^/?#]+)/);
    if (!match) {
      throw new Error(`Expected /h/:serverId/agent/:agentId URL, got ${page.url()}`);
    }
    const serverId = decodeURIComponent(match[1]!);
    const agentId = decodeURIComponent(match[2]!);
    await expect(page.getByRole('textbox', { name: 'Message agent...' })).toBeEditable();
    const initialCopyMessageCount = await page.getByRole('button', { name: 'Copy message' }).count();

    await page.keyboard.press('Control+d');
    await expect
      .poll(async () => page.evaluate(() => (window as any).__mic.active as number))
      .toBe(1);

    await page.keyboard.press('Control+d');

    const newAgentButton = page.getByTestId('sidebar-new-agent');
    await expect(newAgentButton).toBeVisible();
    await newAgentButton.click();
    await expect(page).toHaveURL(/\/h\/[^/]+\/agent(\?|$)/);

    await page.waitForTimeout(10_000);

    const agentEntry = page.getByTestId(`agent-row-${serverId}-${agentId}`).first();
    await expect(agentEntry).toBeVisible();
    await agentEntry.click();
    await expect(page).toHaveURL(
      new RegExp(`/h/${escapeRegex(serverId)}/agent/${escapeRegex(agentId)}(?:\\?|$)`)
    );

    await expect(page.getByRole('button', { name: 'Copy message' })).toHaveCount(initialCopyMessageCount);
    await expect(page.getByTestId('agent-chat-scroll').getByText(/this is a voice note\./i)).toHaveCount(0);
  } finally {
    await repo.cleanup();
  }
});
