import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({
  getRandomValues: <T extends ArrayBufferView | null>(array: T): T => array,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

it("installs the early polyfills before any other app entry import", () => {
  const entry = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
  const firstImport = entry.match(/^import\s.*$/m)?.[0];
  expect(firstImport).toBe('import "./src/polyfills/install-early";');
});

it("loads the native terminal dependency after the early polyfills run", async () => {
  // React Native exposes a navigator without userAgent until the polyfill runs.
  vi.stubGlobal("navigator", {});
  await import("./install-early");

  const require = createRequire(import.meta.url);
  const source = readFileSync(require.resolve("@xterm/headless"), "utf8");
  const module = { exports: {} };
  expect(() =>
    runInNewContext(source, { navigator: globalThis.navigator, module, exports: module.exports }),
  ).not.toThrow();
});
