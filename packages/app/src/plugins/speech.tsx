import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { PluginSpeech } from "@getpaseo/plugin/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useVoiceAudioEngineOptional, useVoiceRuntimeOptional } from "@/contexts/voice-context";
import type { AudioEngine } from "@/voice/audio-engine-types";
import { createReadAloud } from "@/voice/read-aloud";
import { useSessionStore } from "@/stores/session-store";

const controllers = new WeakMap<AudioEngine, ReturnType<typeof createReadAloud>>();
const SpeechHost = createContext<{ client: DaemonClient; serverId: string } | null>(null);
export function PluginSpeechProvider(props: {
  client: DaemonClient;
  serverId: string;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ client: props.client, serverId: props.serverId }),
    [props.client, props.serverId],
  );
  return <SpeechHost.Provider value={value}>{props.children}</SpeechHost.Provider>;
}

export function useSpeech(): PluginSpeech {
  const host = useContext(SpeechHost);
  const engine = useVoiceAudioEngineOptional();
  const voice = useVoiceRuntimeOptional();
  const owner = useRef({}).current;
  if (!host || !engine || !voice)
    throw new Error("Speech is unavailable outside a Paseo plugin surface.");
  let controller = controllers.get(engine);
  if (!controller) {
    controller = createReadAloud(engine);
    controllers.set(engine, controller);
  }
  const runtime = controller;
  const snapshot = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  useEffect(() => {
    const unsubscribe = voice.subscribe(() => {
      const state = voice.getSnapshot();
      if (state.isVoiceMode || state.isVoiceSwitching) runtime.stop(owner);
    });
    const disconnect = host.client.subscribeConnectionStatus((state) => {
      if (state.status !== "connected") runtime.stop(owner);
    });
    return () => {
      unsubscribe();
      disconnect();
      runtime.stop(owner);
    };
  }, [runtime, voice, owner, host]);
  return useMemo(
    () => ({
      ...snapshot,
      key: snapshot.key?.startsWith(`${host.serverId}\0`)
        ? snapshot.key.slice(host.serverId.length + 1)
        : null,
      stop: () => runtime.stop(),
      speak: async (input) => {
        const state = voice.getSnapshot();
        if (state.isVoiceMode || state.isVoiceSwitching)
          throw new Error("End voice mode before reading a response aloud.");
        const info = useSessionStore.getState().getSession(host.serverId)?.serverInfo;
        if (!info?.features?.readAloud)
          throw new Error("This daemon needs the Paseo read-aloud extension.");
        await runtime.speak(
          { ...input, key: `${host.serverId}\0${input.key}` },
          (request, signal) => host.client.renderSpeech(request, signal),
          owner,
        );
      },
    }),
    [snapshot, runtime, voice, host, owner],
  );
}
