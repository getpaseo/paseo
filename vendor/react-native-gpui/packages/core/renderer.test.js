import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const { rendererConfig } = require('./renderer.js');

const roots = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function project(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'desktop'));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(root, 'desktop', name),
      JSON.stringify(contents),
    );
  }
  return root;
}

describe('rendererConfig', () => {
  test('is fabric without a choice', () => {
    expect(rendererConfig(project(), { env: {} })).toEqual({
      renderer: 'fabric',
      jsThread: undefined,
    });
  });

  test('reads desktop.json and lets the OS file and the environment win', () => {
    const root = project({
      'desktop.json': { renderer: 'loom', jsThread: 'main' },
      'desktop.linux.json': { jsThread: 'background' },
    });
    expect(rendererConfig(root, { env: {}, platform: 'darwin' })).toEqual({
      renderer: 'loom',
      jsThread: 'main',
    });
    expect(rendererConfig(root, { env: {}, platform: 'linux' }).jsThread).toBe(
      'background',
    );
    expect(
      rendererConfig(root, {
        env: { RN_GPUI_RENDERER: 'fabric', RN_GPUI_JS_THREAD: '' },
        platform: 'darwin',
      }).renderer,
    ).toBe('fabric');
  });

  test('loom defaults to a background JS thread', () => {
    const root = project({ 'desktop.json': { renderer: 'loom' } });
    expect(rendererConfig(root, { env: {} }).jsThread).toBe('background');
  });

  test('refuses a JS thread without loom and unknown values', () => {
    expect(() =>
      rendererConfig(project({ 'desktop.json': { jsThread: 'main' } }), {
        env: {},
      }),
    ).toThrow(/only available with "renderer": "loom"/);
    expect(() =>
      rendererConfig(project(), { env: { RN_GPUI_RENDERER: 'skia' } }),
    ).toThrow(/renderer must be one of "fabric", "loom"/);
    expect(() =>
      rendererConfig(project({ 'desktop.json': { renderer: 'loom' } }), {
        env: { RN_GPUI_JS_THREAD: 'worker' },
      }),
    ).toThrow(/jsThread must be one of "background", "main"/);
  });
});
