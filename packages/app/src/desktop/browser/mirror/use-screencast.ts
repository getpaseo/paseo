import { Buffer } from "buffer";
import { useEffect, useRef, useState } from "react";
import { PixelRatio } from "react-native";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import {
  EMPTY_SCREENCAST_VIEW,
  retainFrame,
  sameScreencastSize,
  screencastSize,
  subscriptionChange,
  subscriptionErrorView,
  type BrowserScreencastView,
  type ScreencastSize,
} from "./screencast-policy";
import type { PaneSize } from "./viewport";

function createFrameSource(data: Uint8Array) {
  if (typeof Blob === "function" && typeof URL?.createObjectURL === "function") {
    const uri = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: "image/jpeg" }));
    return { uri, release: () => URL.revokeObjectURL(uri) };
  }
  return {
    uri: `data:image/jpeg;base64,${Buffer.from(data).toString("base64")}`,
    release: () => {},
  };
}

interface ScreencastSession {
  requested: ScreencastSize | null;
  visible: boolean;
  token: number;
  frames: Array<ReturnType<typeof createFrameSource>>;
  subscribe: (size: ScreencastSize) => void;
}

export function useBrowserScreencast(
  serverId: string,
  workspaceId: string,
  browserId: string,
  paneSize: PaneSize | null,
): BrowserScreencastView {
  const client = useHostRuntimeClient(serverId);
  const isVisible = useRetainedPanelActive();
  const [view, setView] = useState(EMPTY_SCREENCAST_VIEW);
  const session = useRef<ScreencastSession | null>(null);

  useEffect(() => {
    if (!client) return;
    const current: ScreencastSession = {
      requested: null,
      visible: true,
      token: 0,
      frames: [],
      // Re-subscribing rather than unsubscribing first: the daemon keys viewers
      // by session, so this updates the declared size on the stream already
      // running instead of tearing it down and re-arming the host.
      subscribe: (size) => {
        const token = ++current.token;
        void client
          .subscribeBrowserScreencast(browserId, { ...size, workspaceId })
          .then(({ error }) => {
            if (session.current !== current) return undefined;
            const errorView = subscriptionErrorView(error, token, current.token);
            if (errorView) setView(errorView);
            return undefined;
          });
      },
    };
    session.current = current;
    const unsubscribeFrames = client.onBrowserScreencastFrame((event) => {
      if (event.browserId !== browserId) return;
      const frame = createFrameSource(event.data);
      const [frames, released] = retainFrame(current.frames, frame);
      current.frames = frames;
      released.forEach(({ release }) => release());
      setView({ uri: frame.uri, ...event.metadata, error: null });
    });
    let wasConnected: boolean | null = null;
    const unsubscribeConnection = client.subscribeConnectionStatus((status) => {
      const connected = status.status === "connected";
      const requested = subscriptionChange(wasConnected, connected, current.requested);
      wasConnected = connected;
      if (requested && requested !== "unsubscribe") current.subscribe(requested);
    });

    return () => {
      if (session.current === current) session.current = null;
      unsubscribeFrames();
      unsubscribeConnection();
      client.unsubscribeBrowserScreencast(browserId);
      current.frames.forEach(({ release }) => release());
      setView(EMPTY_SCREENCAST_VIEW);
    };
  }, [browserId, client, workspaceId]);

  useEffect(() => {
    const current = session.current;
    if (!current) return;
    const requested = screencastSize(paneSize, PixelRatio.get());
    if (sameScreencastSize(requested, current.requested)) return;
    current.requested = requested;
    if (requested && current.visible) current.subscribe(requested);
  }, [browserId, client, paneSize, workspaceId]);

  useEffect(() => {
    const current = session.current;
    if (!current) return;
    const decision = subscriptionChange(current.visible, isVisible, current.requested, true);
    current.visible = isVisible;
    if (decision === "unsubscribe") {
      current.token += 1;
      client?.unsubscribeBrowserScreencast(browserId);
      current.frames.forEach(({ release }) => release());
      current.frames = [];
      setView(EMPTY_SCREENCAST_VIEW);
    } else if (decision) {
      current.subscribe(decision);
    }
  }, [browserId, client, isVisible, workspaceId]);

  return view;
}
