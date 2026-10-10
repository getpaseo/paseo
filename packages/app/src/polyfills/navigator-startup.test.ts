import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

it("loads the native terminal dependency with the initial React Native navigator", () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(require.resolve("@xterm/headless"), "utf8");
  // React Native exposes navigator before the app's layout initializes its polyfill.
  expect(() => runInNewContext(source, { navigator: {}, module: { exports: {} } })).not.toThrow();
});
