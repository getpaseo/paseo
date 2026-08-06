/**
 * @vitest-environment jsdom
 *
 * The native sandbox off-device. The WebView is stubbed down to the two things
 * the host actually talks through — the `source` it loads and the `onMessage`
 * it delivers — because the behaviour under test is which document a message is
 * accepted from, and that is decided entirely on this side of the bridge.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginThemeTokens } from "./bridge";
import type { ThemedPluginSandboxProps } from "./theme";

interface CapturedWebView {
  source: { html: string };
  onMessage: (event: { nativeEvent: { data: string } }) => void;
  injectJavaScript: (script: string) => void;
}

const mounted: CapturedWebView[] = [];
const injected: string[] = [];

vi.mock("react-native-webview", () => ({
  WebView: React.forwardRef(
    (
      props: { source: { html: string }; onMessage: CapturedWebView["onMessage"] },
      ref: React.ForwardedRef<unknown>,
    ) => {
      const view: CapturedWebView = {
        source: props.source,
        onMessage: props.onMessage,
        injectJavaScript: (script: string) => injected.push(script),
      };
      mounted.push(view);
      if (typeof ref === "function") {
        ref(view);
      } else if (ref) {
        ref.current = view;
      }
      return null;
    },
  ),
}));

// Stubbed down to the retry callback: the real card pulls in the button and
// i18n, and what this file is about is which document id the retry hands out.
let retry: (() => void) | null = null;
vi.mock("./sandbox-error", () => ({
  PLUGIN_READY_TIMEOUT_MS: 10_000,
  PluginReadyTimeout: (props: { onRetry: () => void }) => {
    retry = props.onRetry;
    return null;
  },
}));

// Not `./sandbox`: that resolves to `sandbox.web.tsx` in any resolver with no
// platform to go on, and the native file is the subject here.
const { PluginSandbox } = await import("@/plugins/sandbox-native");

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

const CONTEXT = { kind: "file-preview", path: "a.csv", content: "x" } as const;

// `withUnistyles` is an identity in tests, so the theme it would inject is
// passed by hand over the top of the public signature.
const Sandbox = PluginSandbox as unknown as (props: ThemedPluginSandboxProps) => React.ReactElement;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  mounted.length = 0;
  injected.length = 0;
  retry = null;
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
    root.render(<Sandbox html={html} context={CONTEXT} themeTokens={THEME_TOKENS} />);
  });
}

function latest(): CapturedWebView {
  const view = mounted.at(-1);
  if (!view) {
    throw new Error(`the sandbox rendered no WebView: ${host.innerHTML}`);
  }
  return view;
}

function documentIdOf(view: CapturedWebView): number {
  const match = /var DOCUMENT_ID = (\d+);/.exec(view.source.html);
  if (!match) {
    throw new Error("the host document carries no document id");
  }
  return Number(match[1]);
}

// Distinct is not enough on Android, where the guest can post to the host
// directly and the stamp is all that marks a message as the relay's. A counter
// would pass the test below and still be guessable on the first try.
it("stamps the first document with an id the plugin cannot guess", () => {
  render("<p>one</p>");

  expect(documentIdOf(latest())).toBeGreaterThan(0x100000);
});

it("stamps each plugin document with its own id", () => {
  render("<p>one</p>");
  const first = documentIdOf(latest());

  render("<p>two</p>");

  expect(documentIdOf(latest())).not.toBe(first);
});

// A WebView swaps documents asynchronously, so the outgoing plugin can still be
// alive and posting when the host has already moved on. Answering its `ready`
// settles the incoming plugin's handshake — and sends an `init` carrying the
// new file's contents into the old plugin's realm.
it("ignores a ready from the document it has already left", () => {
  render("<p>one</p>");
  const stale = documentIdOf(latest());

  render("<p>two</p>");
  act(() => {
    latest().onMessage({
      nativeEvent: { data: JSON.stringify({ document: stale, paseo: 1, type: "ready" }) },
    });
  });

  expect(injected).toEqual([]);
});

// Retry loads a second document of the same plugin, so `html` never changes and
// the swap-driven bump never fires. The timed-out document is still alive — the
// sandbox hides it rather than unmounting, precisely so a late `ready` can still
// land — so sharing an id means that `ready` settles the retry's handshake and
// the `init` answering it goes to a WebView that has no listener installed.
it("gives the retried document an id of its own", () => {
  render("<p>one</p>");
  const timedOut = documentIdOf(latest());
  act(() => {
    vi.advanceTimersByTime(10_000);
  });

  act(() => retry?.());

  expect(documentIdOf(latest())).not.toBe(timedOut);
});

it("ignores a ready from a document the retry has replaced", () => {
  render("<p>one</p>");
  const timedOut = documentIdOf(latest());
  act(() => {
    vi.advanceTimersByTime(10_000);
  });
  act(() => retry?.());

  act(() => {
    latest().onMessage({
      nativeEvent: { data: JSON.stringify({ document: timedOut, paseo: 1, type: "ready" }) },
    });
  });

  expect(injected).toEqual([]);
});

// `ready` is the message the guard was written for, but `open-file` is the one
// that drives host navigation: a stale plugin steering the file pane is the
// worse of the two.
it("ignores an open-file from the document it has already left", () => {
  const onOpenFile = vi.fn();
  act(() => {
    root.render(
      <Sandbox
        html="<p>one</p>"
        context={CONTEXT}
        themeTokens={THEME_TOKENS}
        onOpenFile={onOpenFile}
      />,
    );
  });
  const stale = documentIdOf(latest());

  act(() => {
    root.render(
      <Sandbox
        html="<p>two</p>"
        context={CONTEXT}
        themeTokens={THEME_TOKENS}
        onOpenFile={onOpenFile}
      />,
    );
  });
  act(() => {
    latest().onMessage({
      nativeEvent: {
        data: JSON.stringify({ document: stale, paseo: 1, type: "open-file", path: "b.ts" }),
      },
    });
  });

  expect(onOpenFile).not.toHaveBeenCalled();
});

it("answers a ready from the document it is showing", () => {
  render("<p>one</p>");
  const current = documentIdOf(latest());

  act(() => {
    latest().onMessage({
      nativeEvent: { data: JSON.stringify({ document: current, paseo: 1, type: "ready" }) },
    });
  });

  expect(injected).toHaveLength(1);
  expect(injected[0]).toContain('"type":"init"');
});
