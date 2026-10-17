import { useEffect, useRef } from "react";
import type { DesktopCaptureBridge, DesktopCaptureDraft } from "@getpaseo/protocol/desktop-capture";
import { DesktopCaptureGestureSchema } from "@getpaseo/protocol/desktop-capture";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useDictation } from "@/hooks/use-dictation";
import { useStableEvent } from "@/hooks/use-stable-event";
import { HoldCapture } from "./hold";

export function useHoldCapture(
  bridge: DesktopCaptureBridge | undefined,
  serverId: string | null,
  ready: (capture: DesktopCaptureDraft, text: string, error: string) => void,
) {
  const client = useHostRuntimeClient(serverId ?? "");
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const controller = useRef<HoldCapture | null>(null);
  const text = useRef("");
  const transcript = useStableEvent((value: string) => {
    text.current = value;
  });
  const failed = useStableEvent(() =>
    controller.current?.fail("Micro indisponible. Écrivez votre demande."),
  );
  const voice = useDictation({ client, onTranscript: transcript, onError: failed });
  const start = useStableEvent(async () => {
    text.current = "";
    if (!connected) {
      controller.current?.fail("Connexion à Paseo indisponible. Réessayez.");
      throw new Error("Local daemon disconnected");
    }
    await voice.startDictation();
    if (!voice.isRecordingActive()) throw new Error("Microphone unavailable");
  });
  const finish = useStableEvent(async () => {
    await voice.confirmDictation();
    return text.current;
  });
  const cancel = useStableEvent(async () => {
    await voice.cancelDictation();
  });
  const completed = useStableEvent(ready);
  if (!controller.current)
    controller.current = new HoldCapture({ start, finish, cancel, ready: completed });
  useEffect(() => {
    if (!bridge) return;
    const off = bridge.onGesture((event) =>
      controller.current!.gesture(DesktopCaptureGestureSchema.parse(event)),
    );
    return () => {
      off();
      controller.current?.cancel();
    };
  }, [bridge]);
  return controller.current;
}
