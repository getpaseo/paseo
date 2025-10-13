'use client';

import { useState, useEffect } from 'react';

export function useAudioLevel(stream: MediaStream | null): number {
  const [volume, setVolume] = useState(0);

  useEffect(() => {
    if (!stream) {
      setVolume(0);
      return;
    }

    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let animationId: number;

    function updateVolume() {
      analyser.getByteTimeDomainData(dataArray);

      const rms = Math.sqrt(
        dataArray.reduce((sum, val) => sum + val * val, 0) / dataArray.length
      );

      const normalized = (rms / 255) * 100;
      setVolume(Math.min(100, normalized * 1.5));

      animationId = requestAnimationFrame(updateVolume);
    }

    updateVolume();

    return () => {
      cancelAnimationFrame(animationId);
      source.disconnect();
      audioContext.close();
    };
  }, [stream]);

  return volume;
}
