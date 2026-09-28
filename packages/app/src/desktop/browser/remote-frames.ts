import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Buffer } from "buffer";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { BrowserAutomationCommand } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useAppSettings } from "@/hooks/use-settings";
import { useHostFeature } from "@/runtime/host-features";

export interface RemoteBrowserFrame {
  dataUri: string;
  width: number;
  height: number;
}

interface ViewportSize {
  width: number;
  height: number;
}

interface FrameStream {
  browserId: string;
  settled: Promise<void>;
  failure: Error | null;
}

interface RemoteBrowserFramesInput {
  client: DaemonClient | null;
  serverId: string;
  workspaceId: string;
  remoteBrowserId: string | null;
  remoteBrowserIdRef: RefObject<string | null>;
  viewportSize: ViewportSize;
}

async function captureRemoteFrame(
  client: DaemonClient,
  workspaceId: string,
  browserId: string,
  viewport: ViewportSize,
): Promise<RemoteBrowserFrame | null> {
  const execute = async (command: BrowserAutomationCommand) => {
    const response = await client.executeRemoteBrowserCommand({ workspaceId, command });
    if (!response.ok) throw new Error(response.error.message);
    return response.result;
  };
  const capture = () =>
    execute({
      command: "screenshot",
      args: { browserId, fullPage: false, reveal: true, ephemeral: true },
    });
  let result = await capture();
  const width = Math.round(viewport.width);
  const height = Math.round(viewport.height);
  if (
    result.command === "screenshot" &&
    width >= 50 &&
    height >= 50 &&
    (result.width !== width || result.height !== height)
  ) {
    await execute({ command: "resize", args: { browserId, width, height } });
    result = await capture();
  }
  if (result.command !== "screenshot" || !result.dataBase64) {
    throw new Error("The Linux browser returned no viewport frame");
  }
  if (width >= 50 && height >= 50 && (result.width !== width || result.height !== height)) {
    return null;
  }
  return {
    dataUri: `data:${result.mimeType};base64,${result.dataBase64}`,
    width: result.width,
    height: result.height,
  };
}

/**
 * The remote tab's viewport. Capable daemons push frames while the pane is visible;
 * refreshFrame then only reports whether the current tab's stream failed.
 */
export function useRemoteBrowserFrames(input: RemoteBrowserFramesInput) {
  const { client, serverId, workspaceId, remoteBrowserId, remoteBrowserIdRef } = input;
  const supportsScreencast = useHostFeature(serverId, "browserScreencast");
  const isPanelActive = useRetainedPanelActive();
  const isAppVisible = useAppVisible();
  const isVisible = isPanelActive && isAppVisible;
  const quality = useAppSettings().settings.browserStreamQuality;
  const [frame, setFrame] = useState<RemoteBrowserFrame | null>(null);
  const requestedSizeRef = useRef<ViewportSize | null>(null);
  const viewportSizeRef = useRef(input.viewportSize);
  viewportSizeRef.current = input.viewportSize;
  const streamRef = useRef<FrameStream | null>(null);

  useEffect(() => {
    if (!supportsScreencast || !client || !remoteBrowserId || !isVisible) return;
    const subscription = client.observeBrowserScreencast(
      { workspaceId, browserId: remoteBrowserId, quality },
      (event) => {
        if (event.type === "ended") {
          stream.failure ??= event.error;
          return;
        }
        setFrame({
          dataUri: `data:image/jpeg;base64,${Buffer.from(event.jpeg).toString("base64")}`,
          width: event.width,
          height: event.height,
        });
      },
    );
    const stream: FrameStream = {
      browserId: remoteBrowserId,
      failure: null,
      settled: subscription.ready.then(
        () => undefined,
        (error: unknown) => {
          stream.failure ??= error instanceof Error ? error : new Error(String(error));
        },
      ),
    };
    streamRef.current = stream;
    return () => {
      if (streamRef.current === stream) streamRef.current = null;
      void subscription.release().catch(() => undefined);
    };
  }, [client, isVisible, quality, remoteBrowserId, supportsScreencast, workspaceId]);

  const refreshFrame = useCallback(async () => {
    const currentBrowserId = remoteBrowserIdRef.current;
    if (!currentBrowserId) return;
    if (supportsScreencast) {
      const stream = streamRef.current;
      if (!stream || stream.browserId !== currentBrowserId) return;
      await stream.settled;
      if (stream.failure && streamRef.current === stream) throw stream.failure;
      return;
    }
    // COMPAT(browserScreencast): added in v0.9.1, remove this polling path and
    // captureRemoteFrame after 2027-03-27 once the daemon floor is >= v0.9.1.
    if (!client) throw new Error("The Linux daemon is not connected");
    const viewport = viewportSizeRef.current;
    const nextFrame = await captureRemoteFrame(client, workspaceId, currentBrowserId, viewport);
    if (!nextFrame) return;
    requestedSizeRef.current = {
      width: Math.round(viewport.width),
      height: Math.round(viewport.height),
    };
    setFrame(nextFrame);
  }, [client, remoteBrowserIdRef, supportsScreencast, workspaceId]);

  return { frame, refreshFrame, requestedSizeRef };
}
