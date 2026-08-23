import { useEffect, useRef, useState } from "react";
import { Buffer } from "buffer";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

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

export function useBrowserScreencast(serverId: string, browserId: string): BrowserScreencastView {
  const client = useHostRuntimeClient(serverId);
  const [view, setView] = useState<BrowserScreencastView>(EMPTY_VIEW);
  const frameRef = useRef<FrameSource | null>(null);

  useEffect(() => {
    if (!client) {
      return;
    }

    let active = true;
    const releaseFrame = () => {
      frameRef.current?.release();
      frameRef.current = null;
    };

    const unsubscribeFrames = client.onBrowserScreencastFrame((event) => {
      if (!active || event.browserId !== browserId) {
        return;
      }
      const next = createFrameSource(event.data);
      releaseFrame();
      frameRef.current = next;
      setView({
        uri: next.uri,
        deviceWidth: event.metadata.deviceWidth,
        deviceHeight: event.metadata.deviceHeight,
        error: null,
      });
    });

    void client.subscribeBrowserScreencast(browserId).then((payload) => {
      if (active && payload.error !== null) {
        setView({ ...EMPTY_VIEW, error: payload.error });
      }
    });

    return () => {
      active = false;
      unsubscribeFrames();
      client.unsubscribeBrowserScreencast(browserId);
      releaseFrame();
      setView(EMPTY_VIEW);
    };
  }, [browserId, client]);

  return view;
}
