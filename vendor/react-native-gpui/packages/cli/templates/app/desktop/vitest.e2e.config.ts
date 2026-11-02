import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import desktopPreset from '@react-native-gpui/testing/vitest-preset-e2e';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
process.env.RN_GPUI_TEST_PROJECT = projectRoot;

export default mergeConfig(
  defineConfig(desktopPreset),
  defineConfig({
    root: projectRoot,
    test: { include: ['desktop/e2e/**/*.e2e.ts'] },
  }),
);
