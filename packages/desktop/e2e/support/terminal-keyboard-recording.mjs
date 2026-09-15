import fs from "node:fs/promises";
import path from "node:path";

const overlayId = "paseo-terminal-keyboard-recording";

function jpegSize(bytes) {
  for (let offset = 2; offset < bytes.length; ) {
    const marker = bytes.readUInt16BE(offset);
    const length = bytes.readUInt16BE(offset + 2);
    if (marker === 0xffc0 || marker === 0xffc1 || marker === 0xffc2) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    if (marker === 0xffda || marker === 0xffd9) break;
    offset += length + 2;
  }
  throw new Error("Recording frame has no supported JPEG dimensions");
}

export async function startTerminalKeyboardRecording({ page, artifactDir }) {
  const recordingDir = path.join(artifactDir, "recording");
  const framesDir = path.join(recordingDir, "frames");
  await fs.mkdir(framesDir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const keys = [];
  const pendingAcks = new Set();
  let writeQueue = Promise.resolve();
  let captureError = null;
  let closePromise = null;

  function rememberError(error) {
    captureError ??= error;
  }

  function queueFrame(bytes, timestampSeconds, details) {
    writeQueue = writeQueue
      .then(async () => {
        const file = `frames/frame-${String(frames.length).padStart(6, "0")}.jpeg`;
        const dimensions = jpegSize(bytes);
        await fs.writeFile(path.join(recordingDir, file), bytes);
        return frames.push({ file, timestampSeconds, ...dimensions, ...details });
      })
      .catch(rememberError);
  }

  function onFrame({ data, metadata, sessionId }) {
    queueFrame(Buffer.from(data, "base64"), metadata.timestamp, {
      source: "Page.screencastFrame",
      metadata,
    });
    // Acknowledge independently of disk writes so recording does not block the next frame.
    const ack = cdp.send("Page.screencastFrameAck", { sessionId }).catch(rememberError);
    pendingAcks.add(ack);
    void ack.then(() => pendingAcks.delete(ack));
  }

  async function removeOverlay() {
    await page.evaluate((id) => document.getElementById(id)?.remove(), overlayId);
  }

  async function showKey(label) {
    await page.evaluate(
      ({ id, label: text }) => {
        const overlay = document.getElementById(id);
        if (!overlay) throw new Error("Keyboard recording label is missing");
        overlay.lastElementChild.textContent = text;
      },
      { id: overlayId, label },
    );
    keys.push({ label, timestampSeconds: Date.now() / 1000 });
  }

  async function finish() {
    try {
      await cdp.send("Page.stopScreencast");
      cdp.off("Page.screencastFrame", onFrame);
      await Promise.all(pendingAcks);
      await writeQueue;
      if (captureError) throw captureError;
      if (frames.length === 0) throw new Error("Recording did not receive any screencast frames");

      // Screencasts emit on paint. Capture the actual final view to retain an idle ending.
      const first = frames[0];
      // Screenshot clips use CSS pixels; legacy visualViewport uses device pixels
      // on Retina displays and would double the final frame's dimensions.
      const { cssVisualViewport: visualViewport } = await cdp.send("Page.getLayoutMetrics");
      const screenshotOptions = { format: "jpeg", quality: 95, captureBeyondViewport: false };
      const nativeScreenshot = await cdp.send("Page.captureScreenshot", screenshotOptions);
      const nativeBytes = Buffer.from(nativeScreenshot.data, "base64");
      const nativeSize = jpegSize(nativeBytes);
      const nativeFile = "final-viewport-native.jpeg";
      await fs.writeFile(path.join(recordingDir, nativeFile), nativeBytes);
      // Retina surfaces can exceed the screencast limit. Ask Chromium to capture at the
      // same scale, and keep the native snapshot and scale in the evidence for comparison.
      const scale = first.width / nativeSize.width;
      const clip = {
        x: visualViewport.pageX,
        y: visualViewport.pageY,
        width: visualViewport.clientWidth,
        height: visualViewport.clientHeight,
        scale,
      };
      // ScreencastFrameMetadata.timestamp is Network.TimeSinceEpoch, also in seconds.
      // https://chromedevtools.github.io/devtools-protocol/tot/Page/#type-ScreencastFrameMetadata
      const requestedAtSeconds = Date.now() / 1000;
      const screenshot = await cdp.send("Page.captureScreenshot", { ...screenshotOptions, clip });
      const completedAtSeconds = Date.now() / 1000;
      queueFrame(Buffer.from(screenshot.data, "base64"), completedAtSeconds, {
        source: "Page.captureScreenshot",
        requestedAtSeconds,
        completedAtSeconds,
        clip,
        viewport: visualViewport,
        nativeSnapshot: { file: nativeFile, ...nativeSize },
      });
      await writeQueue;
      if (captureError) throw captureError;

      // CDP delivery can lag newer frames; play each frame at its capture timestamp.
      // Numbered filenames retain the original delivery order for inspection.
      frames.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
      const concat = ["ffconcat version 1.0"];
      for (let index = 0; index < frames.length; index++) {
        const frame = frames[index];
        if (frame.width !== first.width || frame.height !== first.height) {
          throw new Error("Recording dimensions changed; use a fixed Electron window size");
        }
        if (!Number.isFinite(frame.timestampSeconds)) {
          throw new Error("Recording frame is missing its capture timestamp");
        }
        concat.push(`file '${frame.file}'`, "option framerate 1000000");
        const next = frames[index + 1];
        if (next) {
          const duration = next.timestampSeconds - frame.timestampSeconds;
          if (duration <= 0) throw new Error("Recording frame timestamps must increase");
          concat.push(`duration ${duration.toFixed(6)}`);
        }
      }
      const concatPath = path.join(recordingDir, "frames.ffconcat");
      const ffmpegArgs = [
        "-safe",
        "0",
        "-f",
        "concat",
        "-i",
        "frames.ffconcat",
        "-fps_mode",
        "vfr",
        "-c:v",
        "libx264",
        // B-frame reordering can put the final VFR frame beyond the MP4 duration.
        "-bf",
        "0",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-vf",
        "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-enc_time_base:v",
        "1:1000000",
        "-video_track_timescale",
        "1000000",
        "-x264-params",
        "fps=60/1",
        "-movflags",
        "+faststart",
        "interaction.mp4",
      ];
      await fs.writeFile(concatPath, `${concat.join("\n")}\n`);
      await fs.writeFile(
        path.join(recordingDir, "recording.json"),
        `${JSON.stringify(
          {
            source: "Electron renderer captured with a dedicated CDP screencast session",
            width: first.width,
            height: first.height,
            startedAtSeconds: first.timestampSeconds,
            endedAtSeconds: frames.at(-1).timestampSeconds,
            frameCount: frames.length,
            frames,
            keys,
            encoding: { cwd: ".", command: "ffmpeg", args: ffmpegArgs },
            notes: [
              "Frames contain the real renderer and a noninteractive keyboard label.",
              "CDP timestamps are preserved; gaps retain the preceding captured frame.",
              "Frames are ordered by capture timestamp; numbered files preserve delivery order.",
              "The final screenshot uses its completion time; its capture bounds are recorded.",
              "Chromium captures the final screenshot at the screencast resolution; its scale and an unscaled comparison screenshot are retained.",
              "No cursor or success indicators are drawn by the recorder.",
            ],
          },
          null,
          2,
        )}\n`,
      );
      console.log(`Recording frames: ${recordingDir}`);
      console.log(
        `Run from the recording directory with ffmpeg arguments (JSON array): ${JSON.stringify(ffmpegArgs)}`,
      );
    } catch (error) {
      cdp.off("Page.screencastFrame", onFrame);
      await writeQueue;
      await fs.writeFile(
        path.join(recordingDir, "recording.json"),
        `${JSON.stringify({ result: "failed", error: String(error), frames, keys }, null, 2)}\n`,
      );
      throw error;
    } finally {
      cdp.off("Page.screencastFrame", onFrame);
      await Promise.allSettled([writeQueue, ...pendingAcks, cdp.detach(), removeOverlay()]);
    }
  }

  try {
    await page.evaluate((id) => {
      const overlay = document.createElement("div");
      overlay.id = id;
      overlay.setAttribute("aria-hidden", "true");
      Object.assign(overlay.style, {
        position: "fixed",
        right: "24px",
        bottom: "24px",
        zIndex: "2147483647",
        pointerEvents: "none",
        userSelect: "none",
        background: "#111827",
        color: "#ffffff",
        border: "1px solid #64748b",
        borderRadius: "12px",
        padding: "14px 20px",
        boxShadow: "0 4px 20px #0004",
        minWidth: "220px",
        fontFamily: "system-ui, sans-serif",
      });
      const title = document.createElement("div");
      title.textContent = "Keyboard demonstration";
      Object.assign(title.style, { fontSize: "13px", color: "#cbd5e1", marginBottom: "6px" });
      const key = document.createElement("div");
      key.textContent = "Ready";
      Object.assign(key.style, { fontSize: "24px", fontWeight: "600", whiteSpace: "pre-wrap" });
      overlay.append(title, key);
      document.body.append(overlay);
    }, overlayId);
    cdp.on("Page.screencastFrame", onFrame);
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 95,
      maxWidth: 1920,
      maxHeight: 1200,
      everyNthFrame: 1,
    });
  } catch (error) {
    cdp.off("Page.screencastFrame", onFrame);
    await Promise.allSettled([writeQueue, ...pendingAcks, cdp.detach(), removeOverlay()]);
    throw error;
  }

  return {
    showKey,
    close() {
      closePromise ??= finish();
      return closePromise;
    },
  };
}
