import { useCallback, useEffect, useRef, useState } from "react";
import { X, Minimize2, Maximize2, Video, VideoOff, Mic, MicOff } from "lucide-react-native";
import { useSharedSessionStore } from "@/stores/shared-session-store";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

interface PeerState {
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  username: string;
}

interface FloatingVideoPanelProps {
  visible: boolean;
  onClose: () => void;
}

export function FloatingVideoPanel({ visible, onClose }: FloatingVideoPanelProps) {
  const { room, currentUser } = useSharedSessionStore();
  const [videoEnabled, setVideoEnabled] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [peers, setPeers] = useState<Map<string, PeerState>>(new Map());
  const [position, setPosition] = useState({ x: window.innerWidth - 360, y: window.innerHeight - 340 });
  const dragRef = useRef({ startX: 0, startY: 0, isDragging: false });
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, PeerState>>(new Map());

  useEffect(() => {
    if (!room || !visible) return;

    const handler = (signal: any) => {
      void handleSignal(signal);
    };
    room.onMessage?.("webrtc_signal", handler);

    void startMedia(true, true);

    return () => {
      stopMedia();
    };
  }, [room, visible]);

  // Sync video elements when peers change
  useEffect(() => {
    for (const [userId, peer] of peers) {
      const el = document.getElementById(`remote-video-${userId}`) as HTMLVideoElement | null;
      if (el && peer.stream && el.srcObject !== peer.stream) {
        el.srcObject = peer.stream;
      }
    }
  }, [peers]);

  async function startMedia(withVideo: boolean, withAudio: boolean) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: withVideo,
        audio: withAudio,
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      setVideoEnabled(withVideo);
      setAudioEnabled(withAudio);
    } catch (err) {
      console.error("[video] Failed to get media:", err);
    }
  }

  function getOrCreatePeer(userId: string, username: string): PeerState {
    let peer = peersRef.current.get(userId);
    if (peer) return peer;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = (event) => {
      if (event.candidate && room) {
        room.send?.("webrtc_signal", {
          targetUserId: userId,
          kind: "ice-candidate",
          data: event.candidate.toJSON(),
        });
      }
    };

    pc.ontrack = (event) => {
      const p = peersRef.current.get(userId);
      if (p) {
        p.stream = event.streams[0] ?? null;
        setPeers(new Map(peersRef.current));
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
        peersRef.current.delete(userId);
        setPeers(new Map(peersRef.current));
      }
    };

    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) {
        pc.addTrack(track, localStreamRef.current);
      }
    }

    peer = { pc, stream: null, username };
    peersRef.current.set(userId, peer);
    setPeers(new Map(peersRef.current));
    return peer;
  }

  async function handleSignal(signal: { fromUserId: string; fromUsername?: string; kind: string; data: any }) {
    if (signal.fromUserId === currentUser?.userId) return;

    const peer = getOrCreatePeer(signal.fromUserId, signal.fromUsername ?? "Peer");

    if (signal.kind === "offer") {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.data));
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      room?.send?.("webrtc_signal", {
        targetUserId: signal.fromUserId,
        kind: "answer",
        data: answer,
      });
    } else if (signal.kind === "answer") {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.data));
    } else if (signal.kind === "ice-candidate") {
      await peer.pc.addIceCandidate(new RTCIceCandidate(signal.data));
    }
  }

  function stopMedia() {
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) {
        track.stop();
      }
      localStreamRef.current = null;
    }
    for (const peer of peersRef.current.values()) {
      peer.pc.close();
    }
    peersRef.current.clear();
    setPeers(new Map());
    setVideoEnabled(false);
    setAudioEnabled(false);
  }

  function toggleVideo() {
    if (localStreamRef.current) {
      const tracks = localStreamRef.current.getVideoTracks();
      const next = !videoEnabled;
      tracks.forEach((t) => (t.enabled = next));
      setVideoEnabled(next);
    }
  }

  function toggleAudio() {
    if (localStreamRef.current) {
      const tracks = localStreamRef.current.getAudioTracks();
      const next = !audioEnabled;
      tracks.forEach((t) => (t.enabled = next));
      setAudioEnabled(next);
    }
  }

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX - position.x, startY: e.clientY - position.y, isDragging: true };
    const move = (e: MouseEvent) => {
      if (dragRef.current.isDragging) {
        setPosition({ x: e.clientX - dragRef.current.startX, y: e.clientY - dragRef.current.startY });
      }
    };
    const up = () => { dragRef.current.isDragging = false; document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }, [position]);

  if (!visible) return null;

  const peerList = Array.from(peers.values());
  const totalVideos = peerList.length + 1; // +1 for local
  const cols = totalVideos <= 1 ? 1 : totalVideos <= 4 ? 2 : 3;
  const panelWidth = minimized ? 200 : (cols === 1 ? 240 : cols === 2 ? 360 : 520);

  return (
    <div style={{
      position: "fixed", left: position.x, top: position.y, width: panelWidth,
      zIndex: 9999, borderRadius: 12, overflow: "hidden",
      backgroundColor: "#111113", border: "1px solid #27272a",
      boxShadow: "0 8px 32px rgba(0,0,0,0.4)", transition: "width 0.2s",
    }}>
      {/* Header */}
      <div onMouseDown={handleMouseDown as any} style={{
        display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
        cursor: "grab", backgroundColor: "#18181b",
        borderBottom: minimized ? "none" : "1px solid #27272a", userSelect: "none",
      }}>
        <span style={{ flex: 1, fontSize: 11, color: "#a1a1aa", fontWeight: 500 }}>
          {totalVideos > 1 ? `${totalVideos} participants` : currentUser?.username ?? "Call"}
        </span>
        <button onClick={() => setMinimized(!minimized)} style={iconBtnStyle}>
          {minimized ? <Maximize2 size={12} color="#71717a" /> : <Minimize2 size={12} color="#71717a" />}
        </button>
        <button onClick={() => { stopMedia(); onClose(); }} style={iconBtnStyle}>
          <X size={12} color="#71717a" />
        </button>
      </div>

      {!minimized && (
        <>
          {/* Video grid */}
          <div style={{
            display: "grid",
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gap: 2, padding: 2, backgroundColor: "#09090b",
          }}>
            {/* Local video */}
            <div style={{ position: "relative", aspectRatio: "4/3", backgroundColor: "#09090b", overflow: "hidden", borderRadius: 4 }}>
              <video ref={localVideoRef as any} autoPlay playsInline muted
                style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }} />
              <span style={{
                position: "absolute", bottom: 4, left: 6, fontSize: 10, color: "#e5e5e5",
                backgroundColor: "rgba(0,0,0,0.6)", padding: "1px 6px", borderRadius: 4,
              }}>
                You
              </span>
            </div>

            {/* Remote videos */}
            {peerList.map(({ stream, username }, i) => (
              <div key={`peer-${i}`} style={{ position: "relative", aspectRatio: "4/3", backgroundColor: "#09090b", overflow: "hidden", borderRadius: 4 }}>
                <video id={`remote-video-${Array.from(peers.keys())[i]}`} autoPlay playsInline
                  style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                {!stream && (
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#71717a", fontSize: 11 }}>
                    Connecting...
                  </div>
                )}
                <span style={{
                  position: "absolute", bottom: 4, left: 6, fontSize: 10, color: "#e5e5e5",
                  backgroundColor: "rgba(0,0,0,0.6)", padding: "1px 6px", borderRadius: 4,
                }}>
                  {username}
                </span>
              </div>
            ))}
          </div>

          {/* Controls */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            padding: "6px 10px", backgroundColor: "#18181b",
          }}>
            <button onClick={toggleAudio} style={ctrlBtnStyle(audioEnabled)}>
              {audioEnabled ? <Mic size={14} color="#e5e5e5" /> : <MicOff size={14} color="#71717a" />}
            </button>
            <button onClick={toggleVideo} style={ctrlBtnStyle(videoEnabled)}>
              {videoEnabled ? <Video size={14} color="#e5e5e5" /> : <VideoOff size={14} color="#71717a" />}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex", alignItems: "center",
};

function ctrlBtnStyle(active: boolean): React.CSSProperties {
  return {
    width: 32, height: 32, borderRadius: 16, display: "flex", alignItems: "center", justifyContent: "center",
    border: `1px solid ${active ? "#3f3f46" : "#27272a"}`,
    backgroundColor: active ? "#27272a" : "transparent", cursor: "pointer",
  };
}
