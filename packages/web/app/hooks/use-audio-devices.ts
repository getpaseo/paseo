'use client';

import { useState, useEffect } from 'react';

interface AudioDevice {
  deviceId: string;
  label: string;
}

function isSecureContext(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext;
}

function hasMediaDevices(): boolean {
  return typeof navigator !== 'undefined' && 'mediaDevices' in navigator && !!navigator.mediaDevices;
}

export function useAudioDevices() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadDevices() {
      if (!isSecureContext()) {
        setError('HTTPS required. Please access this app over HTTPS or localhost.');
        setIsLoading(false);
        return;
      }

      if (!hasMediaDevices()) {
        setError('Media devices not supported in this browser.');
        setIsLoading(false);
        return;
      }

      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });

        const deviceList = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = deviceList
          .filter(device => device.kind === 'audioinput')
          .map(device => ({
            deviceId: device.deviceId,
            label: device.label || `Microphone ${device.deviceId.slice(0, 8)}`,
          }));

        setDevices(audioInputs);

        if (audioInputs.length > 0 && !selectedDeviceId) {
          setSelectedDeviceId(audioInputs[0].deviceId);
        }
      } catch (error) {
        console.error('Error loading audio devices:', error);
        setError('Failed to access microphone. Please grant permission.');
      } finally {
        setIsLoading(false);
      }
    }

    loadDevices();

    if (hasMediaDevices()) {
      navigator.mediaDevices.addEventListener('devicechange', loadDevices);

      return () => {
        navigator.mediaDevices.removeEventListener('devicechange', loadDevices);
      };
    }
  }, [selectedDeviceId]);

  return {
    devices,
    selectedDeviceId,
    setSelectedDeviceId,
    isLoading,
    error,
  };
}
