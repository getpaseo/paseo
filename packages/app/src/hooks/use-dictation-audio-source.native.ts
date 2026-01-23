import { useCallback, useEffect, useRef } from "react";

import { useSpeechmaticsAudio } from "@/hooks/use-speechmatics-audio";

import type { DictationAudioSource, DictationAudioSourceConfig } from "./use-dictation-audio-source.types";

export function useDictationAudioSource(config: DictationAudioSourceConfig): DictationAudioSource {
  const onPcmSegmentRef = useRef(config.onPcmSegment);
  const onErrorRef = useRef(config.onError);

  useEffect(() => {
    onPcmSegmentRef.current = config.onPcmSegment;
    onErrorRef.current = config.onError;
  }, [config.onPcmSegment, config.onError]);

  const speechmatics = useSpeechmaticsAudio({
    enableContinuousStreaming: true,
    onAudioSegment: ({ audioData }) => {
      onPcmSegmentRef.current(audioData);
    },
    onError: (err) => {
      onErrorRef.current?.(err);
    },
    volumeThreshold: 0.3,
    silenceDuration: 2000,
    speechConfirmationDuration: 300,
    detectionGracePeriod: 200,
  });

  const start = useCallback(async () => {
    await speechmatics.start();
  }, [speechmatics]);

  const stop = useCallback(async () => {
    await speechmatics.stop();
  }, [speechmatics]);

  return {
    start,
    stop,
    volume: speechmatics.volume,
  };
}

