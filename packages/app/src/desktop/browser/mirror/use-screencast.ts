import { useEffect, useRef, useState } from "react";
import { PixelRatio } from "react-native";
import { Buffer } from "buffer";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { PaneSize } from "./viewport";

export interface BrowserScreencastView {
  uri: string | null;
  deviceWidth: number;
  deviceHeight: number;
  error: string | null;
}

interface FrameSource {
  uri: string;
  release: () => void;
}

const EMPTY_VIEW: BrowserScreencastView = {
  uri: null,
  deviceWidth: 0,
  deviceHeight: 0,
  error: null,
};

// Every distinct size the pane reports re-arms the host capture, so the request
// climbs in steps: a drag across a whole step costs one re-arm, not one a pixel.
const SCREENCAST_SIZE_STEP = 320;

// The host encodes a JPEG of this many pixels per frame and the viewer decodes
// it, which is what a keystroke waits on. A retina pane asks for four times the
// pixels it has, so cap the budget rather than the device ratio.
const SCREENCAST_MAX_PIXELS = 4_000_000;

/** The displayed frame plus the one behind it, which may still be decoding. */
const FRAME_RETENTION = 2;

/**
 * Object URLs keep the JPEG bytes out of JavaScript strings on web and Electron.
 * React Native has no Blob URL, so it pays a base64 copy per frame.
 */
function createFrameSource(data: Uint8Array): FrameSource {
  if (typeof Blob === "function" && typeof URL?.createObjectURL === "function") {
    const uri = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: "image/jpeg" }));
    return { uri, release: () => URL.revokeObjectURL(uri) };
  }
  return {
    uri: `data:image/jpeg;base64,${Buffer.from(data).toString("base64")}`,
    release: () => {},
  };
}

function quantise(pixels: number): number {
  return Math.max(1, Math.round(pixels / SCREENCAST_SIZE_STEP)) * SCREENCAST_SIZE_STEP;
}

function requestedSize(pane: PaneSize): { maxWidth: number; maxHeight: number } {
  const ratio = PixelRatio.get();
  let width = pane.width * ratio;
  let height = pane.height * ratio;
  const budget = SCREENCAST_MAX_PIXELS / (width * height);
  if (budget < 1) {
    const scale = Math.sqrt(budget);
    width *= scale;
    height *= scale;
  }
  return { maxWidth: quantise(width), maxHeight: quantise(height) };
}

/**
 * The pane is the only party that knows how many pixels it can show, so it
 * declares them. `paneSize` is null until layout, and nothing is subscribed
 * until then: subscribing with a placeholder would re-arm the host immediately.
 */
export function useBrowserScreencast(
  serverId: string,
  browserId: string,
  paneSize: PaneSize | null,
): BrowserScreencastView {
  const client = useHostRuntimeClient(serverId);
  const [view, setView] = useState<BrowserScreencastView>(EMPTY_VIEW);
  const framesRef = useRef<FrameSource[]>([]);
  const requested = paneSize ? requestedSize(paneSize) : null;
  const maxWidth = requested?.maxWidth ?? null;
  const maxHeight = requested?.maxHeight ?? null;

  useEffect(() => {
    if (!client) {
      return;
    }

    let active = true;
    const releaseFrames = () => {
      for (const frame of framesRef.current) {
        frame.release();
      }
      framesRef.current = [];
    };

    const unsubscribeFrames = client.onBrowserScreencastFrame((event) => {
      if (!active || event.browserId !== browserId) {
        return;
      }
      const next = createFrameSource(event.data);
      // Revoking the URL the <img> is still decoding paints a broken image, and
      // the swap is a React render behind this callback. Keep one frame of slack.
      framesRef.current.push(next);
      while (framesRef.current.length > FRAME_RETENTION) {
        framesRef.current.shift()?.release();
      }
      setView({
        uri: next.uri,
        deviceWidth: event.metadata.deviceWidth,
        deviceHeight: event.metadata.deviceHeight,
        error: null,
      });
    });

    return () => {
      active = false;
      unsubscribeFrames();
      client.unsubscribeBrowserScreencast(browserId);
      releaseFrames();
      setView(EMPTY_VIEW);
    };
  }, [browserId, client]);

  useEffect(() => {
    if (!client || maxWidth === null || maxHeight === null) {
      return;
    }
    // Re-subscribing rather than unsubscribing first: the daemon keys viewers by
    // session, so this updates the declared size on the stream already running.
    let active = true;
    void (async () => {
      const payload = await client.subscribeBrowserScreencast(browserId, { maxWidth, maxHeight });
      if (active && payload.error !== null) {
        setView({ ...EMPTY_VIEW, error: payload.error });
      }
    })();
    return () => {
      active = false;
    };
  }, [browserId, client, maxHeight, maxWidth]);

  return view;
}
