import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const metroDir = require('node:path').dirname(
  require.resolve('metro/package.json'),
);
const workerPath = require.resolve('metro-transform-worker', {
  paths: [metroDir],
});

describe('metro-transform-worker', () => {
  it('turns off the build-time Platform.OS inlining and nothing else', async () => {
    const worker = require(workerPath);
    const transform = vi.spyOn(worker, 'transform').mockResolvedValue('out');
    const ours = require('./metro-transform-worker.js');
    const options = { dev: true, platform: 'desktop', inlinePlatform: true };
    await expect(
      ours.transform({}, '/root', 'a.js', '', options),
    ).resolves.toBe('out');
    expect(transform).toHaveBeenCalledWith({}, '/root', 'a.js', '', {
      dev: true,
      platform: 'desktop',
      inlinePlatform: false,
    });
    expect(options.inlinePlatform).toBe(true);
    transform.mockRestore();
  });
});
