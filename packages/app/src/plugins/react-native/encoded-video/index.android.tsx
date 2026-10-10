import {
  type ComponentProps,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { StyleSheet } from "react-native";
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";
import { z } from "zod";
import type { EncodedVideoHandle, EncodedVideoProps } from "@getpaseo/plugin/client/react-native";
import { encodedVideoHtml } from "./runtime";

const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("error"), message: z.string(), generation: z.number().int() }),
  z.object({ type: z.literal("dequeue"), generation: z.number().int() }),
  z.object({
    type: z.literal("frame"),
    generation: z.number().int(),
    frame: z.object({
      id: z.number().int(),
      timestamp: z.number(),
      displayWidth: z.number().positive(),
      displayHeight: z.number().positive(),
    }),
  }),
  z.object({
    type: z.literal("presented"),
    generation: z.number().int(),
    requestId: z.number().int(),
  }),
]);
interface PendingPaint {
  resolve(): void;
  reject(error: Error): void;
}
const source = { html: encodedVideoHtml, baseUrl: "https://paseo-video.invalid/" };
const originWhitelist = ["https://paseo-video.invalid"];
function allowNavigation(request: WebViewNavigation): boolean {
  return request.url === source.baseUrl || request.url === "about:blank";
}
const styles = StyleSheet.create({ canvas: { backgroundColor: "transparent" } });

/** A private secure-origin canvas. Bridge generations fence reset/unmount and late decoder output. */
export const EncodedVideo = forwardRef<EncodedVideoHandle, EncodedVideoProps>(
  function EncodedVideo(props, ref) {
    const webview = useRef<WebView>(null);
    const callbacks = useRef(props);
    callbacks.current = props;
    const generation = useRef(0);
    const nextRequest = useRef(0);
    const pending = useRef(new Map<number, PendingPaint>());
    const ready = useRef(false);

    function rejectPending(error: Error) {
      for (const paint of pending.current.values()) paint.reject(error);
      pending.current.clear();
    }
    function send(message: object) {
      if (!ready.current || !webview.current) throw new Error("Video decoder is not ready");
      const payload = JSON.stringify({ ...message, generation: generation.current });
      webview.current.injectJavaScript(`window.__PASEO_VIDEO__(${payload});true;`);
    }
    function fail(error: Error) {
      generation.current += 1;
      rejectPending(error);
      callbacks.current.onError(error);
    }
    /** Document failures require readiness again; codec errors keep the loaded bridge usable. */
    function failBridge(error: Error) {
      ready.current = false;
      fail(error);
    }

    useImperativeHandle(
      ref,
      () => ({
        configure(config) {
          generation.current += 1;
          rejectPending(new Error("Video decoder replaced"));
          send({ type: "configure", config });
        },
        decode(chunk) {
          send({ type: "decode", chunk });
        },
        reset() {
          generation.current += 1;
          rejectPending(new Error("Video decoder reset"));
          // React clears native refs before passive unmount cleanup. A plugin's
          // decoder cleanup may still hold this handle during that interval.
          if (ready.current && webview.current) send({ type: "reset" });
        },
        present(frameId) {
          const requestId = ++nextRequest.current;
          return new Promise<void>((resolve, reject) => {
            pending.current.set(requestId, { resolve, reject });
            try {
              send({ type: "present", frameId, requestId });
            } catch (error) {
              pending.current.delete(requestId);
              reject(error);
            }
          });
        },
        release(frameId) {
          if (ready.current && webview.current) send({ type: "release", frameId });
        },
      }),
      [],
    );

    useEffect(
      () => () => {
        ready.current = false;
        generation.current += 1;
        rejectPending(new Error("Video surface unmounted"));
      },
      [],
    );

    const onMessage = useCallback((event: WebViewMessageEvent) => {
      let value: unknown;
      try {
        value = JSON.parse(event.nativeEvent.data);
      } catch {
        failBridge(new Error("Invalid video decoder message"));
        return;
      }
      const result = messageSchema.safeParse(value);
      if (!result.success) {
        failBridge(new Error("Invalid video decoder message"));
        return;
      }
      const message = result.data;
      if (message.type === "ready") {
        ready.current = true;
        callbacks.current.onReady();
        return;
      }
      if ("generation" in message && message.generation !== generation.current) return;
      if (message.type === "error") {
        fail(new Error(message.message));
        return;
      }
      if (message.type === "frame") callbacks.current.onFrame(message.frame);
      if (message.type === "dequeue") callbacks.current.onDequeue();
      if (message.type === "presented") {
        pending.current.get(message.requestId)?.resolve();
        pending.current.delete(message.requestId);
      }
    }, []);
    const onError = useCallback<NonNullable<ComponentProps<typeof WebView>["onError"]>>(
      (event) => failBridge(new Error(event.nativeEvent.description)),
      [],
    );
    const onRenderProcessGone = useCallback(
      () => failBridge(new Error("Video decoder process stopped")),
      [],
    );

    return (
      <WebView
        ref={webview}
        source={source}
        originWhitelist={originWhitelist}
        onShouldStartLoadWithRequest={allowNavigation}
        onMessage={onMessage}
        onError={onError}
        onRenderProcessGone={onRenderProcessGone}
        javaScriptEnabled
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        style={[styles.canvas, props.style]}
      />
    );
  },
);
