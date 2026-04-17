import { useCallback, useEffect, useRef, useState } from "react";
import {
  Minimize2,
  Maximize2,
  Video,
  VideoOff,
  Mic,
  MicOff,
  Pencil,
  Trash2,
} from "lucide-react-native";
import { useSharedParticipants, useSharedSessionStore } from "@/stores/shared-session-store";
import {
  DRAW_PALETTE,
  setDrawActive,
  setDrawColor,
  useSharedDrawState,
} from "@/stores/shared-draw-store";
import { Fonts } from "@/constants/theme";

const PANEL_FONT_FAMILY =
  (Fonts as { sans?: string } | undefined)?.sans ??
  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

interface PeerState {
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  username: string;
  sessionId: string;
}

interface FloatingVideoPanelProps {
  visible: boolean;
  onClose: () => void;
}

export function FloatingVideoPanel({ visible, onClose }: FloatingVideoPanelProps) {
  const { room, currentUser } = useSharedSessionStore();
  const remoteParticipants = useSharedParticipants();
  const [videoEnabled, setVideoEnabled] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [peers, setPeers] = useState<Map<string, PeerState>>(new Map());
  const [position, setPosition] = useState({
    x: window.innerWidth - 360,
    y: window.innerHeight - 340,
  });
  const dragRef = useRef({ startX: 0, startY: 0, isDragging: false });
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, PeerState>>(new Map());
  // Monotonic generation counter — if startMedia is called twice concurrently
  // (React StrictMode, effect re-runs), older getUserMedia resolutions are
  // discarded so we don't end up with an orphaned stream still transmitting.
  const streamGenRef = useRef(0);
  // Resolved when localStreamRef.current is populated — used to block incoming
  // signals that arrive before getUserMedia completes, so peers are never
  // created without local tracks.
  const streamReadyRef = useRef<{
    promise: Promise<void>;
    resolve: () => void;
  } | null>(null);
  if (!streamReadyRef.current) {
    let resolver: () => void = () => undefined;
    const promise = new Promise<void>((r) => {
      resolver = r;
    });
    streamReadyRef.current = { promise, resolve: resolver };
  }

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

  // Sync video elements when peers change. Keep this minimal — just attach
  // srcObject and let the browser's autoPlay handle playback. Adding explicit
  // play() / muted reassignment here caused audio regressions.
  useEffect(() => {
    for (const [userId, peer] of peers) {
      const el = document.getElementById(`remote-video-${userId}`) as HTMLVideoElement | null;
      if (el && peer.stream && el.srcObject !== peer.stream) {
        el.srcObject = peer.stream;
      }
    }
  }, [peers]);

  // Deterministic single-initiator per pair: the peer with the lexicographically
  // smaller Colyseus sessionId sends the offer. Since sessionIds are fresh on
  // every connect (including post-F5), this also automatically picks a new
  // initiator when one side refreshes and both sides need a fresh PC.
  useEffect(() => {
    if (!room || !visible || !currentUser) return;
    if (!localStreamRef.current) return;
    const mySessionId = (room as { sessionId?: string }).sessionId ?? "";
    const myId = currentUser.userId;
    const liveUserIds = new Set<string>();
    for (const participant of remoteParticipants.values()) {
      const peerId = participant.userId;
      if (!peerId || peerId === myId) continue;
      liveUserIds.add(peerId);
      const existing = peersRef.current.get(peerId);
      // Backfill sessionId when handleSignal created the peer before
      // participants_list arrived — don't destroy a working connection.
      if (existing && !existing.sessionId && participant.sessionId) {
        existing.sessionId = participant.sessionId;
      }
      const sessionChanged =
        existing && existing.sessionId && existing.sessionId !== participant.sessionId;
      const connectionDead =
        existing &&
        (existing.pc.connectionState === "failed" ||
          existing.pc.connectionState === "closed" ||
          existing.pc.connectionState === "disconnected");
      if (existing && !sessionChanged && !connectionDead) continue;
      if (existing) {
        try {
          existing.pc.close();
        } catch {}
        peersRef.current.delete(peerId);
      }
      // Deterministic single-initiator per pair: the peer with the
      // lexicographically smaller sessionId sends the offer. Don't create
      // the PC on the non-initiator side — pre-added sendonly transceivers
      // would desync the answer's m-lines and silently drop audio.
      const shouldInitiate = mySessionId < participant.sessionId;
      if (!shouldInitiate) continue;
      const peer = getOrCreatePeer(peerId, participant.username, participant.sessionId);
      void (async () => {
        try {
          const offer = await peer.pc.createOffer();
          await peer.pc.setLocalDescription(offer);
          room.send?.("webrtc_signal", {
            targetUserId: peerId,
            kind: "offer",
            data: peer.pc.localDescription,
          });
        } catch (err) {
          console.error("[video] failed to create offer:", err);
        }
      })();
    }
    for (const [peerId, peer] of peersRef.current) {
      if (!liveUserIds.has(peerId)) {
        try {
          peer.pc.close();
        } catch {}
        peersRef.current.delete(peerId);
        setPeers(new Map(peersRef.current));
      }
    }
  }, [remoteParticipants, room, visible, currentUser, videoEnabled]);

  async function startMedia(withVideo: boolean, withAudio: boolean) {
    const gen = ++streamGenRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: withVideo,
        audio: withAudio
          ? {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            }
          : false,
      });
      // Superseded by a newer startMedia (strict-mode double-invoke or
      // effect re-run). Release so it doesn't leak or keep transmitting.
      if (gen !== streamGenRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (localStreamRef.current && localStreamRef.current !== stream) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      localStreamRef.current = stream;
      attachLocalStreamToVideo();
      setVideoEnabled(withVideo);
      setAudioEnabled(withAudio);
      streamReadyRef.current?.resolve();
    } catch (err) {
      console.error("[video] failed to get media:", err);
    }
  }

  function attachLocalStreamToVideo() {
    const el = localVideoRef.current;
    const stream = localStreamRef.current;
    if (!el || !stream) return;
    if (el.srcObject !== stream) {
      el.srcObject = stream;
    }
    // Safari + some Chrome versions require an explicit play() on elements
    // whose src was set programmatically even with autoPlay attribute.
    el.play?.().catch((err) => console.warn("[video] local play() failed:", err));
  }

  // Re-attach streams whenever the video elements remount (e.g. when the
  // panel was minimized and expanded again). Both the local <video> and each
  // remote peer <video> need to be re-wired to their MediaStream otherwise
  // they render black after restore.
  useEffect(() => {
    if (!visible || minimized) return;
    const reattach = () => {
      // Local
      if (localStreamRef.current && localVideoRef.current) {
        attachLocalStreamToVideo();
      }
      // Remote peers
      for (const [userId, peer] of peersRef.current) {
        if (!peer.stream) continue;
        const el = document.getElementById(`remote-video-${userId}`) as HTMLVideoElement | null;
        if (el && el.srcObject !== peer.stream) {
          el.srcObject = peer.stream;
          el.play?.().catch(() => undefined);
        }
      }
    };
    // Immediate reattach + short interval to cover element mount delay.
    reattach();
    const interval = setInterval(reattach, 250);
    const timeout = setTimeout(() => clearInterval(interval), 2000);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [visible, minimized]);

  function getOrCreatePeer(userId: string, username: string, sessionId: string): PeerState {
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
      if (pc.connectionState === "failed") {
        try {
          pc.restartIce();
        } catch {}
      }
    };

    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) {
        pc.addTrack(track, localStreamRef.current);
      }
    }

    peer = {
      pc,
      stream: null,
      username,
      sessionId,
    };
    peersRef.current.set(userId, peer);
    setPeers(new Map(peersRef.current));
    return peer;
  }

  async function handleSignal(signal: {
    fromUserId: string;
    fromUsername?: string;
    kind: string;
    data: any;
  }) {
    if (signal.fromUserId === currentUser?.userId) return;
    // Don't create a peer connection until local tracks are available, or the
    // resulting PC will have no outbound media and the remote side will be
    // stuck on "Connecting..." forever waiting for our tracks.
    if (!localStreamRef.current && streamReadyRef.current) {
      await streamReadyRef.current.promise;
    }

    // Look up live session for the sender so we can associate the peer with it.
    let senderSessionId = "";
    for (const p of remoteParticipants.values()) {
      if (p.userId === signal.fromUserId) {
        senderSessionId = p.sessionId;
        break;
      }
    }
    // If we have a stale peer (from before the sender refreshed), tear it down
    // so getOrCreatePeer below creates a fresh PC matching the new sessionId.
    // We detect staleness by either sessionId mismatch or a dead connectionState,
    // and on receipt of a fresh offer (which implies the sender started over).
    const existing = peersRef.current.get(signal.fromUserId);
    const sessionMismatch =
      existing && senderSessionId && existing.sessionId && existing.sessionId !== senderSessionId;
    const connectionDead =
      existing &&
      (existing.pc.connectionState === "failed" ||
        existing.pc.connectionState === "closed" ||
        existing.pc.connectionState === "disconnected");
    const incomingOfferWithAnswerState =
      existing &&
      signal.kind === "offer" &&
      existing.pc.signalingState !== "stable" &&
      existing.pc.signalingState !== "have-remote-offer";
    if (existing && (sessionMismatch || connectionDead || incomingOfferWithAnswerState)) {
      try {
        existing.pc.close();
      } catch {}
      peersRef.current.delete(signal.fromUserId);
    }
    const peer = getOrCreatePeer(signal.fromUserId, signal.fromUsername ?? "Peer", senderSessionId);

    try {
      if (signal.kind === "offer") {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.data));
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        room?.send?.("webrtc_signal", {
          targetUserId: signal.fromUserId,
          kind: "answer",
          data: peer.pc.localDescription,
        });
      } else if (signal.kind === "answer") {
        if (peer.pc.signalingState === "have-local-offer") {
          await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.data));
        }
      } else if (signal.kind === "ice-candidate") {
        try {
          await peer.pc.addIceCandidate(new RTCIceCandidate(signal.data));
        } catch (err) {
          console.warn("[video] failed to add ICE candidate:", err);
        }
      }
    } catch (err) {
      console.error("[video] handleSignal error:", err, signal.kind);
    }
  }

  function stopMedia() {
    // Bump generation so any in-flight startMedia resolution is discarded.
    streamGenRef.current += 1;
    // Reset the stream-ready promise for the next session so a fresh
    // getUserMedia must complete before any new signals are processed.
    let resolver: () => void = () => undefined;
    const promise = new Promise<void>((r) => {
      resolver = r;
    });
    streamReadyRef.current = { promise, resolve: resolver };
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

  // User-gesture handlers (click) unlock autoplay-with-audio for remote videos.
  // Must be called synchronously inside the click handler, not after any await.
  function unlockRemoteAudio() {
    for (const [userId] of peersRef.current) {
      const el = document.getElementById(`remote-video-${userId}`) as HTMLVideoElement | null;
      if (!el) continue;
      el.muted = false;
      el.volume = 1;
      el.play?.().catch(() => undefined);
    }
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

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragRef.current = {
        startX: e.clientX - position.x,
        startY: e.clientY - position.y,
        isDragging: true,
      };
      const move = (e: MouseEvent) => {
        if (dragRef.current.isDragging) {
          setPosition({
            x: e.clientX - dragRef.current.startX,
            y: e.clientY - dragRef.current.startY,
          });
        }
      };
      const up = () => {
        dragRef.current.isDragging = false;
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    },
    [position],
  );

  // onClose is intentionally not wired to a close button — the panel stays
  // visible for the duration of the shared session. Exit happens via "Sair".
  void onClose;

  if (!visible) return null;

  const peerList = Array.from(peers.values());
  const peerKeys = Array.from(peers.keys());
  const totalVideos = peerList.length + 1;
  const cols = totalVideos <= 1 ? 1 : totalVideos <= 2 ? 2 : totalVideos <= 4 ? 2 : 3;
  const tileSize = cols === 1 ? 220 : cols === 2 ? 180 : 150;
  const panelWidth = minimized
    ? 220
    : cols === 1
      ? tileSize + 12
      : cols * tileSize + (cols - 1) * 4 + 12;

  return (
    <div
      style={{
        position: "fixed",
        left: position.x,
        top: position.y,
        width: panelWidth,
        zIndex: 9999,
        borderRadius: 12,
        overflow: "hidden",
        backgroundColor: "rgba(15,15,17,0.95)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
        transition: "width 0.18s ease",
        fontFamily: PANEL_FONT_FAMILY,
      }}
    >
      {/* Header */}
      <div
        onMouseDown={handleMouseDown as any}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          cursor: "grab",
          borderBottom: minimized ? "none" : "1px solid rgba(255,255,255,0.06)",
          userSelect: "none",
        }}
      >
        <span style={{ flex: 1, fontSize: 12, color: "#d4d4d8", fontWeight: 500 }}>
          {totalVideos > 1 ? `${totalVideos} participants` : (currentUser?.username ?? "Call")}
        </span>
        <button
          onClick={() => setMinimized(!minimized)}
          style={iconBtnStyle}
          aria-label={minimized ? "Expand" : "Minimize"}
        >
          {minimized ? (
            <Maximize2 size={13} color="#a1a1aa" />
          ) : (
            <Minimize2 size={13} color="#a1a1aa" />
          )}
        </button>
      </div>

      {!minimized && (
        <>
          {/* Video grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${cols}, 1fr)`,
              gap: 4,
              padding: 6,
              backgroundColor: "#09090b",
            }}
          >
            {/* Local video */}
            <VideoTile label="You" isLocal>
              <video
                ref={localVideoRef as any}
                autoPlay
                playsInline
                muted
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  transform: "scaleX(-1)",
                }}
              />
            </VideoTile>

            {/* Remote peers */}
            {peerList.map((peer, i) => {
              const key = peerKeys[i];
              return (
                <VideoTile
                  key={`peer-${key}`}
                  label={peer.username}
                  isLocal={false}
                  showConnecting={!peer.stream}
                >
                  <video
                    id={`remote-video-${key}`}
                    autoPlay
                    playsInline
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                </VideoTile>
              );
            })}
          </div>

          {/* Controls */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              padding: "10px",
              backgroundColor: "rgba(24,24,27,0.6)",
              borderTop: "1px solid rgba(255,255,255,0.04)",
            }}
          >
            <button
              onClick={() => {
                unlockRemoteAudio();
                toggleAudio();
              }}
              style={ctrlBtnStyle(audioEnabled)}
              aria-label={audioEnabled ? "Mute mic" : "Unmute mic"}
            >
              {audioEnabled ? (
                <Mic size={16} color="#fafafa" />
              ) : (
                <MicOff size={16} color="#fca5a5" />
              )}
            </button>
            <button
              onClick={() => {
                unlockRemoteAudio();
                toggleVideo();
              }}
              style={ctrlBtnStyle(videoEnabled)}
              aria-label={videoEnabled ? "Stop camera" : "Start camera"}
            >
              {videoEnabled ? (
                <Video size={16} color="#fafafa" />
              ) : (
                <VideoOff size={16} color="#fca5a5" />
              )}
            </button>
            <DrawControls roomSend={(type, payload) => room?.send?.(type, payload)} />
          </div>
        </>
      )}
    </div>
  );
}

function DrawControls({
  roomSend,
}: {
  roomSend: (type: string, payload?: unknown) => void;
}) {
  const { active, color } = useSharedDrawState();
  const [paletteOpen, setPaletteOpen] = useState(false);
  return (
    <div style={{ position: "relative", display: "flex", gap: 6 }}>
      <button
        onClick={() => {
          if (active) {
            setDrawActive(false);
            setPaletteOpen(false);
          } else {
            setDrawActive(true);
            setPaletteOpen(true);
          }
        }}
        style={{
          ...ctrlBtnStyle(active),
          // Tint the pencil button with the current color when active so the
          // user sees what they're drawing with at a glance.
          borderColor: active ? color : "rgba(255,255,255,0.08)",
        }}
        aria-label={active ? "Stop drawing" : "Start drawing"}
      >
        <Pencil size={16} color={active ? color : "#fafafa"} />
      </button>
      {active && (
        <button
          onClick={() => {
            roomSend("draw_clear");
          }}
          style={ctrlBtnStyle(false)}
          aria-label="Clear drawings"
        >
          <Trash2 size={14} color="#fafafa" />
        </button>
      )}
      {paletteOpen && active && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            display: "flex",
            gap: 6,
            padding: 6,
            borderRadius: 10,
            background: "rgba(10,10,10,0.9)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          {DRAW_PALETTE.map((c) => (
            <button
              key={c}
              onClick={() => {
                setDrawColor(c);
                setPaletteOpen(false);
              }}
              aria-label={`Color ${c}`}
              style={{
                width: 20,
                height: 20,
                borderRadius: 10,
                background: c,
                border:
                  c === color ? "2px solid #fff" : "1px solid rgba(255,255,255,0.15)",
                cursor: "pointer",
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function VideoTile({
  children,
  label,
  isLocal,
  showConnecting,
}: {
  children: React.ReactNode;
  label: string;
  isLocal: boolean;
  showConnecting?: boolean;
}) {
  return (
    <div
      style={{
        position: "relative",
        aspectRatio: "4/3",
        backgroundColor: "#09090b",
        overflow: "hidden",
        borderRadius: 8,
        border: "1px solid rgba(255,255,255,0.04)",
      }}
    >
      {children}
      {showConnecting ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#71717a",
            fontSize: 11,
          }}
        >
          Connecting...
        </div>
      ) : null}
      <span
        style={{
          position: "absolute",
          bottom: 6,
          left: 6,
          fontSize: 10,
          fontWeight: 500,
          color: "#e5e5e5",
          backgroundColor: "rgba(0,0,0,0.55)",
          padding: "2px 8px",
          borderRadius: 6,
          maxWidth: "calc(100% - 12px)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          pointerEvents: "none",
        }}
      >
        {isLocal ? `${label}` : label}
      </span>
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  padding: 4,
  borderRadius: 4,
  display: "flex",
  alignItems: "center",
};

function ctrlBtnStyle(active: boolean): React.CSSProperties {
  return {
    width: 36,
    height: 36,
    borderRadius: 18,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: `1px solid ${active ? "rgba(255,255,255,0.1)" : "rgba(252,165,165,0.25)"}`,
    backgroundColor: active ? "rgba(255,255,255,0.06)" : "rgba(252,165,165,0.08)",
    cursor: "pointer",
    transition: "background 0.15s, border-color 0.15s",
  };
}
