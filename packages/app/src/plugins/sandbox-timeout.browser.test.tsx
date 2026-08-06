/**
 * The web sandbox appends the plugin frame imperatively, so the container it
 * appends into has to survive every state this component can be in. It did not
 * survive the timeout: the card replaced it, which nulled the ref, and a plugin
 * whose `html` changed after that got a mount effect with no container to
 * append to and no dep left to re-fire on. Blank pane, no way back.
 *
 * In a real browser rather than a DOM stub, because the thing under test is
 * whether a real `<iframe>` ends up in a real container.
 */
const testGlobals = globalThis as typeof globalThis & {
  __DEV__?: boolean;
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
testGlobals.__DEV__ = false;
testGlobals.IS_REACT_ACT_ENVIRONMENT = true;

// Imported by name because the browser project transforms JSX with the classic
// runtime, so `React` has to be in scope here.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
// Imported for its side effect of initialising i18next; the card renders copy.
import { i18n } from "@/i18n/i18next";
import { PluginSandbox as PluginSandboxWithInjectedTheme } from "./sandbox.web";
import type { ThemedPluginSandboxProps } from "./theme";
import { PLUGIN_READY_TIMEOUT_MS } from "./sandbox-error";
import type { PluginThemeTokens } from "./bridge";

// `withUnistyles` is stubbed to an identity in tests, so the theme it would
// have injected is passed by hand.
const THEME_TOKENS: PluginThemeTokens = {
  colorScheme: "dark",
  background: "#000000",
  foreground: "#ffffff",
  foregroundMuted: "#888888",
  border: "#333333",
  accent: "#0000ff",
  fontFamily: "sans-serif",
  monoFontFamily: "monospace",
  fontSize: 14,
};

// No `ready` post, so the handshake always times out.
const SILENT_PLUGIN = "<p>silent</p>";

const FILE_CONTEXT = { kind: "file-preview", path: "a.csv", content: "x" } as const;

// The export hides `themeTokens`, since `withUnistyles` supplies it in the app.
// The stub does not, so the test hands it over the top of that signature.
const PluginSandbox = PluginSandboxWithInjectedTheme as unknown as (
  props: ThemedPluginSandboxProps,
) => React.ReactElement;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  expect(i18n.isInitialized).toBe(true);
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

function render(html: string) {
  act(() => {
    root.render(
      <PluginSandbox
        html={html}
        context={FILE_CONTEXT}
        testID="plugin-sandbox"
        themeTokens={THEME_TOKENS}
      />,
    );
  });
}

test("a plugin that times out and then changes its html gets a frame again", () => {
  render(SILENT_PLUGIN);
  expect(host.querySelectorAll("iframe")).toHaveLength(1);

  act(() => void vi.advanceTimersByTime(PLUGIN_READY_TIMEOUT_MS));
  expect(host.textContent).toContain("did not finish loading");

  render("<p>a different plugin</p>");
  // Was zero: the container had been unmounted with the card, so the mount
  // effect found a null ref and returned.
  expect(host.querySelectorAll("iframe")).toHaveLength(1);
});
