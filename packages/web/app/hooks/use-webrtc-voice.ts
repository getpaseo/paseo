'use client';

import { useState, useCallback, useRef } from 'react';
import type { RealtimeServerEvent, AgentStatus } from '../types/realtime-events';

interface UseWebRTCVoiceReturn {
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  stream: MediaStream | null;
  agentStatus: AgentStatus;
  connect: (deviceId?: string) => Promise<void>;
  disconnect: () => void;
}

interface UseWebRTCVoiceOptions {
  onEvent?: (event: RealtimeServerEvent) => void;
  onStatusChange?: (status: AgentStatus) => void;
}

export function useWebRTCVoice(options: UseWebRTCVoiceOptions = {}): UseWebRTCVoiceReturn {
  const { onEvent, onStatusChange } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('disconnected');

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const connect = useCallback(async (deviceId?: string) => {
    if (isConnecting || isConnected) return;

    setIsConnecting(true);
    setError(null);

    try {
      if (!window.isSecureContext) {
        throw new Error('HTTPS required. Please access this app over HTTPS or localhost.');
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Media devices not supported in this browser.');
      }

      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };

      if (deviceId) {
        audioConstraints.deviceId = { exact: deviceId };
      }

      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints
      });
      streamRef.current = micStream;
      setStream(micStream);

      const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
      const response = await fetch(`${basePath}/api/session`, { method: 'POST' });
      if (!response.ok) {
        throw new Error('Failed to get session token');
      }
      const { client_secret } = await response.json();

      const pc = new RTCPeerConnection();
      peerConnectionRef.current = pc;

      micStream.getTracks().forEach(track => pc.addTrack(track, micStream));

      const dc = pc.createDataChannel('oai-events');
      dataChannelRef.current = dc;

      // Listen for data channel messages (realtime events from server)
      dc.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as RealtimeServerEvent;
          onEvent?.(data);
        } catch (err) {
          console.error('Failed to parse data channel message:', err);
        }
      };

      dc.onopen = () => {
        console.log('Data channel opened');
      };

      dc.onclose = () => {
        console.log('Data channel closed');
      };

      pc.ontrack = (event) => {
        const audioElement = new Audio();
        audioElement.autoplay = true;
        audioElement.srcObject = event.streams[0];
        audioElementRef.current = audioElement;
        audioElement.play().catch(err => {
          console.error('Error playing audio:', err);
        });
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setIsConnected(true);
          setIsConnecting(false);
          setAgentStatus('connected');
          onStatusChange?.('connected');
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setError('Connection failed');
          setIsConnected(false);
          setIsConnecting(false);
          setAgentStatus('disconnected');
          onStatusChange?.('disconnected');
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch(
        `https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${client_secret.value}`,
            'Content-Type': 'application/sdp',
          },
          body: offer.sdp,
        }
      );

      if (!sdpResponse.ok) {
        throw new Error('Failed to connect to OpenAI');
      }

      const answerSdp = await sdpResponse.text();
      const answer: RTCSessionDescriptionInit = {
        type: 'answer',
        sdp: answerSdp,
      };
      await pc.setRemoteDescription(answer);

    } catch (err) {
      console.error('Connection error:', err);
      setError(err instanceof Error ? err.message : 'Failed to connect');
      setIsConnecting(false);
      setIsConnected(false);

      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
        setStream(null);
      }
    }
  }, [isConnecting, isConnected]);

  const disconnect = useCallback(() => {
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      setStream(null);
    }

    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.srcObject = null;
      audioElementRef.current = null;
    }

    setIsConnected(false);
    setIsConnecting(false);
    setError(null);
    setAgentStatus('disconnected');
  }, []);

  return {
    isConnected,
    isConnecting,
    error,
    stream,
    agentStatus,
    connect,
    disconnect,
  };
}
