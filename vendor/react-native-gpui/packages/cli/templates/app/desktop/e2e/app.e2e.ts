import { beforeAll, expect, test } from 'vitest';
import { launchApp, type DesktopApp } from '@react-native-gpui/testing';

let app: DesktopApp;
beforeAll(async () => {
  app = await launchApp({
    disableAnimations: true,
    idleOptions: { ignore: ['animations'] },
  });
});

test('renders the React Native app', async () => {
  await app.waitForIdle();
  // Existing React Native apps do not need to add a testID to adopt desktop.
  const tree = (await app.tree()) as { children: unknown[] };
  expect(tree.children.length).toBeGreaterThan(0);
});
