import { useEffect, useState } from "react";
import { PixelRatio } from "react-native";
import { Buffer } from "buffer";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import {
  BrowserScreencastController,
  EMPTY_SCREENCAST_VIEW,
  type BrowserScreencastView,
  type ScreencastFrameSource,
} from "./screencast-controller";
import type { PaneSize } from "./viewport";

/**
 * Object URLs keep the JPEG bytes out of JavaScript strings on web and Electron.
 * React Native has no Blob URL, so it pays a base64 copy per frame.
 */
function createFrameSource(data: Uint8Array): ScreencastFrameSource {
  if (typeof Blob === "function" && typeof URL?.createObjectURL === "function") {
    const uri = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: "image/jpeg" }));
    return { uri, release: () => URL.revokeObjectURL(uri) };
  }
  return {
    uri: `data:image/jpeg;base64,${Buffer.from(data).toString("base64")}`,
    release: () => {},
  };
}

function readPixelRatio(): number {
  return PixelRatio.get();
}

/**
 * Binds one pane to the stream controller: the pane declares its size, the
 * controller decides what that costs the host, and the newest frame renders.
 */
export function useBrowserScreencast(
  serverId: string,
  workspaceId: string,
  browserId: string,
  paneSize: PaneSize | null,
): BrowserScreencastView {
  const client = useHostRuntimeClient(serverId);
  const isVisible = useRetainedPanelActive();
  const [view, setView] = useState<BrowserScreencastView>(EMPTY_SCREENCAST_VIEW);
  const [controller, setController] = useState<BrowserScreencastController | null>(null);

  useEffect(() => {
    if (!client) {
      return;
    }
    const next = new BrowserScreencastController({
      client,
      browserId,
      workspaceId,
      getPixelRatio: readPixelRatio,
      createFrameSource,
      onView: setView,
    });
    setController(next);
    return () => {
      setController(null);
      next.dispose();
    };
  }, [browserId, client, workspaceId]);

  useEffect(() => {
    controller?.setPaneSize(paneSize);
  }, [controller, paneSize]);

  useEffect(() => {
    controller?.setVisible(isVisible);
  }, [controller, isVisible]);

  return view;
}
