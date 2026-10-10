/** Private canvas runtime kept as source text because Hermes cannot serialize functions. */
export const encodedVideoHtml = String.raw`<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<style>html,body,canvas{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}canvas{display:block}</style>
</head><body><canvas></canvas><script>(() => {
  function encodedVideoRuntime() {
    const canvas = document.querySelector("canvas");
    const context = canvas.getContext("2d");
    let decoder = null;
    let generation = 0;
    let nextFrame = 0;
    let hostGeneration = 0;
    let lastTimestamp = -1;
    const frames = new Map();
    const queued = [];
    const bridge = Reflect.get(window, "ReactNativeWebView");
    const post = (message) => bridge.postMessage(JSON.stringify(message));
    const bytes = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    function reset() {
      generation += 1;
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = null;
      for (const frame of frames.values()) frame.close();
      frames.clear();
      queued.length = 0;
      lastTimestamp = -1;
    }
    function fail(error) {
      reset();
      post({ type: "error", generation: hostGeneration, message: error instanceof Error ? error.message : String(error) });
    }
    Reflect.set(
      window,
      "__PASEO_VIDEO__",
      (message) => {
        try {
          if (message.type === "configure") {
            reset();
            const current = generation;
            hostGeneration = message.generation;
            const outputGeneration = hostGeneration;
            const config = message.config;
            decoder = new VideoDecoder({
              output(frame) {
                if (generation !== current) {
                  frame.close();
                  return;
                }
                if (frames.size >= 64) {
                  frame.close();
                  fail(new Error("Video frame buffer exceeded"));
                  return;
                }
                const id = ++nextFrame;
                frames.set(id, frame);
                post({
                  type: "frame",
                  generation: hostGeneration,
                  frame: {
                    id,
                    timestamp: frame.timestamp,
                    displayWidth: frame.displayWidth,
                    displayHeight: frame.displayHeight
                  }
                });
              },
              error(error) {
                if (generation === current) fail(error);
              }
            });
            decoder.addEventListener("dequeue", () => {
              if (generation !== current || !decoder) return;
              const completed = queued.length - decoder.decodeQueueSize;
              for (let index = 0; index < completed; index += 1) {
                queued.shift();
                post({ type: "dequeue", generation: outputGeneration });
              }
            });
            const { descriptionBase64, ...settings } = config;
            decoder.configure({
              ...settings,
              ...descriptionBase64 ? { description: bytes(descriptionBase64) } : {}
            });
          } else if (message.type === "reset") {
            hostGeneration = message.generation;
            reset();
          } else if (message.type === "decode") {
            if (!decoder || queued.length >= 4) throw new Error("Video decode queue exceeded");
            const chunk = message.chunk;
            if (chunk.dataBase64.length > 2796204) throw new Error("Video packet exceeded 2 MiB");
            queued.push(chunk.timestamp);
            decoder.decode(
              new EncodedVideoChunk({
                type: chunk.type,
                timestamp: chunk.timestamp,
                data: bytes(chunk.dataBase64)
              })
            );
          } else if (message.type === "release") {
            frames.get(message.frameId)?.close();
            frames.delete(message.frameId);
          } else if (message.type === "present") {
            const frame = frames.get(message.frameId);
            if (!frame) throw new Error("Video frame was released");
            const current = generation;
            requestAnimationFrame(() => {
              if (generation !== current) return;
              try {
                if (!frames.has(message.frameId)) throw new Error("Video frame was released before presentation");
                if (frame.timestamp <= lastTimestamp) throw new Error("Obsolete video presentation");
                canvas.width = frame.displayWidth;
                canvas.height = frame.displayHeight;
                context.drawImage(frame, 0, 0);
                lastTimestamp = frame.timestamp;
                post({
                  type: "presented",
                  generation: message.generation,
                  requestId: message.requestId
                });
              } catch (error) {
                fail(error);
              }
            });
          }
        } catch (error) {
          fail(error);
        }
      }
    );
    window.addEventListener("pagehide", reset);
    if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined" || !context) {
      fail(new Error("Video streaming requires an updated Android System WebView"));
      return;
    }
    post({ type: "ready" });
  }
 encodedVideoRuntime();
})();</script></body></html>`;
