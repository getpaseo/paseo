import { useCallback, useEffect, useRef, useState } from "react";
import type { Room } from "./colyseus-client";

interface PeerConnection {
  userId: string;
  pc: RTCPeerConnection;
  stream: MediaStream | null;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/**
 * WebRTC audio hook for web/Electron.
 * Uses native RTCPeerConnection API.
 * Signaling goes through the Colyseus room.
 */
export function useWebRTCAudio(room: Room | null, myUserId: string | null) {
  const peersRef = useRef<Map<string, PeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [peerCount, setPeerCount] = useState(0);

  // Listen for WebRTC signals from the room
  useEffect(() => {
    if (!room || !myUserId) return;

    const handler = (signal: {
      fromUserId: string;
      fromUsername: string;
      kind: string;
      data: any;
    }) => {
      void handleSignal(signal.fromUserId, signal.kind, signal.data);
    };

    room.onMessage("webrtc_signal", handler);

    return () => {
      // Cleanup all peer connections
      for (const peer of peersRef.current.values()) {
        peer.pc.close();
      }
      peersRef.current.clear();
      setPeerCount(0);

      if (localStreamRef.current) {
        for (const track of localStreamRef.current.getTracks()) {
          track.stop();
        }
        localStreamRef.current = null;
      }
    };
  }, [room, myUserId]);

  async function getLocalStream(): Promise<MediaStream> {
    if (localStreamRef.current) return localStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    localStreamRef.current = stream;
    return stream;
  }

  function getOrCreatePeer(remoteUserId: string): PeerConnection {
    let peer = peersRef.current.get(remoteUserId);
    if (peer) return peer;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = (event) => {
      if (event.candidate && room) {
        room.send("webrtc_signal", {
          targetUserId: remoteUserId,
          kind: "ice-candidate",
          data: event.candidate.toJSON(),
        });
      }
    };

    pc.ontrack = (event) => {
      const existing = peersRef.current.get(remoteUserId);
      if (existing) {
        existing.stream = event.streams[0] ?? null;
        // Create audio element to play remote audio
        if (event.streams[0]) {
          const audio = new Audio();
          audio.srcObject = event.streams[0];
          audio.autoplay = true;
          void audio.play().catch(() => {});
        }
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
        peersRef.current.delete(remoteUserId);
        pc.close();
        setPeerCount(peersRef.current.size);
      }
    };

    peer = { userId: remoteUserId, pc, stream: null };
    peersRef.current.set(remoteUserId, peer);
    setPeerCount(peersRef.current.size);
    return peer;
  }

  async function handleSignal(fromUserId: string, kind: string, data: any): Promise<void> {
    const peer = getOrCreatePeer(fromUserId);

    if (kind === "offer") {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data));

      // Add local audio track before creating answer
      const stream = await getLocalStream();
      for (const track of stream.getTracks()) {
        peer.pc.addTrack(track, stream);
      }

      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);

      room?.send("webrtc_signal", {
        targetUserId: fromUserId,
        kind: "answer",
        data: answer,
      });
    } else if (kind === "answer") {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data));
    } else if (kind === "ice-candidate") {
      await peer.pc.addIceCandidate(new RTCIceCandidate(data));
    }
  }

  const startAudio = useCallback(
    async (participantUserIds: string[]) => {
      if (!room || !myUserId) return;

      const stream = await getLocalStream();

      // Send offer to each participant
      for (const targetUserId of participantUserIds) {
        if (targetUserId === myUserId) continue;

        const peer = getOrCreatePeer(targetUserId);

        // Add local tracks
        for (const track of stream.getTracks()) {
          peer.pc.addTrack(track, stream);
        }

        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);

        room.send("webrtc_signal", {
          targetUserId,
          kind: "offer",
          data: offer,
        });
      }

      setAudioEnabled(true);
      room.send("audio_toggle", { enabled: true });
    },
    [room, myUserId],
  );

  const stopAudio = useCallback(() => {
    // Stop all tracks
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) {
        track.stop();
      }
      localStreamRef.current = null;
    }

    // Close all peer connections
    for (const peer of peersRef.current.values()) {
      peer.pc.close();
    }
    peersRef.current.clear();
    setPeerCount(0);

    setAudioEnabled(false);
    room?.send("audio_toggle", { enabled: false });
  }, [room]);

  const toggleAudio = useCallback(
    async (participantUserIds: string[]) => {
      if (audioEnabled) {
        stopAudio();
      } else {
        await startAudio(participantUserIds);
      }
    },
    [audioEnabled, startAudio, stopAudio],
  );

  return {
    audioEnabled,
    peerCount,
    toggleAudio,
    startAudio,
    stopAudio,
  };
}
