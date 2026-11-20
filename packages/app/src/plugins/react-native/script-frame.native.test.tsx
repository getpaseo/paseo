/**
 * @vitest-environment jsdom
 */
// Native ScriptFrame, with a fake WebView that records what the frame hands it.
import React, { act, createRef } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScriptFrameHandle } from "@getpaseo/plugin/client/ui";
import { SCRIPT_FRAME_CSP } from "./script-frame-page";
import { ScriptFrame } from "./script-frame.native";

/** The props of the frame's WebView that the tests call or read; the settings ride along. */
interface WebViewProps {
  testID?: string;
  source: { html: string; baseUrl: string };
  onShouldStartLoadWithRequest(request: { url: string }): boolean;
  onMessage(event: { nativeEvent: { data: string } }): void;
  onError(event: { nativeEvent: { description: string } }): void;
  onRenderProcessGone(event: { nativeEvent: { didCrash: boolean } }): void;
  [setting: string]: unknown;
}

const webview = vi.hoisted(() => ({
  props: null as WebViewProps | null,
  injected: [] as string[],
}));

vi.mock("react-native-webview", async () => {
  const react = await import("react");
  const WebView = react.forwardRef((props: { testID?: string }, ref) => {
    webview.props = props as WebViewProps;
    react.useImperativeHandle(ref, () => ({
      injectJavaScript: (code: string) => webview.injected.push(code),
    }));
    return react.createElement("div", { "data-testid": props.testID });
  });
  return { WebView };
});

beforeEach(() => {
  vi.stubGlobal("React", React);
  webview.props = null;
  webview.injected = [];
});
afterEach(cleanup);

/** What the page does: a message posted through ReactNativeWebView.postMessage. */
function fromPage(message: object): void {
  act(() => webview.props?.onMessage({ nativeEvent: { data: JSON.stringify(message) } }));
}

function mount(overrides: Partial<React.ComponentProps<typeof ScriptFrame>> = {}) {
  const handle = createRef<ScriptFrameHandle>();
  const onMessage = vi.fn();
  const onError = vi.fn();
  render(
    <ScriptFrame
      ref={handle}
      script="window.answer = 1;"
      title="Office in 3D"
      testID="frame"
      onMessage={onMessage}
      onError={onError}
      {...overrides}
    />,
  );
  return { handle, onMessage, onError };
}

describe("Native ScriptFrame", () => {
  it("runs a local script with storage, file access and new windows disabled", () => {
    mount();
    const props = webview.props!;
    expect(props.source.baseUrl).toMatch(/^https:\/\/[a-f0-9-]+\.invalid\/$/);
    expect(props.source.html).toContain("window.answer = 1;");
    expect(props.source.html).toContain(SCRIPT_FRAME_CSP);
    expect({
      javaScriptEnabled: props.javaScriptEnabled,
      domStorageEnabled: props.domStorageEnabled,
      allowFileAccess: props.allowFileAccess,
      allowFileAccessFromFileURLs: props.allowFileAccessFromFileURLs,
      setSupportMultipleWindows: props.setSupportMultipleWindows,
      javaScriptCanOpenWindowsAutomatically: props.javaScriptCanOpenWindowsAutomatically,
      thirdPartyCookiesEnabled: props.thirdPartyCookiesEnabled,
      mediaPlaybackRequiresUserAction: props.mediaPlaybackRequiresUserAction,
      accessibilityLabel: props.accessibilityLabel,
    }).toEqual({
      javaScriptEnabled: true,
      domStorageEnabled: false,
      allowFileAccess: false,
      allowFileAccessFromFileURLs: false,
      setSupportMultipleWindows: false,
      javaScriptCanOpenWindowsAutomatically: false,
      thirdPartyCookiesEnabled: false,
      mediaPlaybackRequiresUserAction: true,
      accessibilityLabel: "Office in 3D",
    });
  });

  it("gives separately mounted frames distinct origins", () => {
    mount();
    const first = webview.props!.source.baseUrl;
    mount();
    expect(webview.props!.source.baseUrl).not.toBe(first);
  });

  it("allows the first load of its own address and nothing else", () => {
    mount();
    const allow = webview.props!.onShouldStartLoadWithRequest as (r: { url: string }) => boolean;
    expect(allow({ url: "https://example.com/" })).toBe(false);
    expect(allow({ url: webview.props!.source.baseUrl })).toBe(true);
    expect(allow({ url: webview.props!.source.baseUrl })).toBe(false);
    // react-native-webview opens a URL that fails `originWhitelist` in the system browser
    // without asking `onShouldStartLoadWithRequest`, so every URL has to pass it.
    expect(webview.props!.originWhitelist).toEqual(["*"]);
  });

  it("holds posts until the page is ready, then injects them in order", () => {
    const { handle } = mount();
    act(() => {
      handle.current?.post("one");
      handle.current?.post("two");
    });
    expect(webview.injected).toEqual([]);
    fromPage({ paseoFrame: "ready" });
    expect(webview.injected).toHaveLength(2);
    expect(webview.injected[0]).toContain('f("one")');
    expect(webview.injected[1]).toContain('f("two")');
    act(() => handle.current?.post("three"));
    expect(webview.injected[2]).toContain('f("three")');
  });

  it("hands the page's text to onMessage and ignores what is not an envelope", () => {
    const { onMessage } = mount();
    fromPage({ paseoFrame: "message", text: "from the page" });
    act(() => webview.props?.onMessage({ nativeEvent: { data: "not json" } }));
    fromPage({ other: 1 });
    expect(onMessage.mock.calls).toEqual([["from the page"]]);
  });

  it("reports the page's own errors, a failed load and a dead renderer to onError", () => {
    const { onError } = mount();
    fromPage({ paseoFrame: "error", message: "boom" });
    act(() => webview.props?.onError({ nativeEvent: { description: "net::ERR_FAILED" } }));
    act(() => webview.props?.onRenderProcessGone({ nativeEvent: { didCrash: true } }));
    expect(onError.mock.calls).toEqual([
      ["boom"],
      ["net::ERR_FAILED"],
      ["The page's process ended"],
    ]);
  });

  it("waits again for ready when the script changes", () => {
    const handle = createRef<ScriptFrameHandle>();
    const onMessage = vi.fn();
    const { rerender } = render(
      <ScriptFrame ref={handle} script="a" title="t" onMessage={onMessage} />,
    );
    expect(
      webview.props!.onShouldStartLoadWithRequest({ url: webview.props!.source.baseUrl }),
    ).toBe(true);
    fromPage({ paseoFrame: "ready" });
    rerender(<ScriptFrame ref={handle} script="b" title="t" onMessage={onMessage} />);
    act(() => handle.current?.post("after reload"));
    expect(webview.injected).toEqual([]);
    expect(
      webview.props!.onShouldStartLoadWithRequest({ url: webview.props!.source.baseUrl }),
    ).toBe(true);
    fromPage({ paseoFrame: "ready" });
    expect(webview.injected).toHaveLength(1);
  });

  it("keeps one post for its life, so a post kept from the first render still reaches the page", () => {
    const handle = createRef<ScriptFrameHandle>();
    const onMessage = vi.fn();
    const { rerender } = render(
      <ScriptFrame ref={handle} script="a" title="t" onMessage={onMessage} />,
    );
    const post = handle.current!.post;
    rerender(<ScriptFrame ref={handle} script="b" title="t" onMessage={onMessage} />);
    fromPage({ paseoFrame: "ready" });
    act(() => post("kept"));
    expect(handle.current?.post).toBe(post);
    expect(webview.injected).toHaveLength(1);
  });
});
