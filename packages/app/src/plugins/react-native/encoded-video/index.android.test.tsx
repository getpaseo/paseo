/**
 * @vitest-environment jsdom
 */
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { EncodedVideoConfig, EncodedVideoHandle } from "@getpaseo/plugin/client/react-native";
import { EncodedVideo } from "./index.android";

interface WebViewCallbacks {
  onMessage(event: { nativeEvent: { data: string } }): void;
  onRenderProcessGone(): void;
}

// Only the native transport is replaced. React mounts the production host;
// runtime.test.ts exercises the decoder document with actual Chromium codecs.
const transport = vi.hoisted(() => {
  let callbacks: WebViewCallbacks | null = null;
  return {
    injectJavaScript: vi.fn<(script: string) => void>(),
    attach(value: WebViewCallbacks) {
      callbacks = value;
    },
    message(value: object) {
      if (!callbacks) throw new Error("WebView is not mounted");
      callbacks.onMessage({ nativeEvent: { data: JSON.stringify(value) } });
    },
    stopProcess() {
      if (!callbacks) throw new Error("WebView is not mounted");
      callbacks.onRenderProcessGone();
    },
  };
});

vi.mock("react-native-webview", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    WebView: forwardRef(function TestWebView(props: WebViewCallbacks, ref) {
      transport.attach(props);
      useImperativeHandle(ref, () => ({ injectJavaScript: transport.injectJavaScript }), []);
      return null;
    }),
  };
});

const roots: ReturnType<typeof createRoot>[] = [];
const containers: HTMLElement[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const container of containers.splice(0)) container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** Mount the Android host with its real imperative handle and callback ownership. */
async function mountVideo() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("React", React);
  const container = document.createElement("div");
  containers.push(container);
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const ref = createRef<EncodedVideoHandle>();
  const onReady = vi.fn();
  const onFrame = vi.fn();
  const onError = vi.fn();
  await act(async () => {
    root.render(
      <EncodedVideo
        ref={ref}
        onReady={onReady}
        onFrame={onFrame}
        onError={onError}
        onDequeue={vi.fn()}
      />,
    );
  });
  if (!ref.current) throw new Error("Video handle is not mounted");
  transport.message({ type: "ready" });
  return { handle: ref.current, onReady, onFrame, onError };
}

const config: EncodedVideoConfig = {
  codec: "vp8",
  codedWidth: 16,
  codedHeight: 16,
  optimizeForLatency: true,
};

it("reconfigures a mounted decoder after error while rejecting failed and stale paints", async () => {
  const { handle, onReady, onFrame, onError } = await mountVideo();
  handle.configure(config);
  const failedPaint = expect(handle.present(1)).rejects.toThrow("Unsupported codec");
  transport.message({ type: "error", generation: 1, message: "Unsupported codec" });
  await failedPaint;
  expect(onError).toHaveBeenCalledExactlyOnceWith(new Error("Unsupported codec"));

  handle.configure(config);
  expect(transport.injectJavaScript).toHaveBeenLastCalledWith(
    'window.__PASEO_VIDEO__({"type":"configure","config":{"codec":"vp8","codedWidth":16,"codedHeight":16,"optimizeForLatency":true},"generation":3});true;',
  );
  const frame = { id: 2, timestamp: 2000, displayWidth: 16, displayHeight: 16 };
  transport.message({ type: "frame", generation: 1, frame });
  expect(onFrame).not.toHaveBeenCalled();
  transport.message({ type: "frame", generation: 3, frame });
  expect(onFrame).toHaveBeenCalledExactlyOnceWith(frame);
  const recoveredPaint = handle.present(frame.id);
  transport.message({ type: "presented", generation: 3, requestId: 2 });
  await expect(recoveredPaint).resolves.toBeUndefined();
  expect(onReady).toHaveBeenCalledTimes(1);
});

it("keeps a stopped WebView unavailable until its replacement document is ready", async () => {
  const { handle } = await mountVideo();
  handle.configure(config);
  const failedPaint = expect(handle.present(1)).rejects.toThrow("Video decoder process stopped");
  transport.stopProcess();
  await failedPaint;
  expect(() => handle.configure(config)).toThrow("Video decoder is not ready");
  expect(() => handle.reset()).not.toThrow();
  transport.message({ type: "ready" });
  expect(() => handle.configure(config)).not.toThrow();
});
