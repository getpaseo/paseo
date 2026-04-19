import "@livekit/components-styles";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { PreJoin, type LocalUserChoices } from "@livekit/components-react";
import {
  getSharedMediaPreferences,
  setSharedMediaPreferences,
} from "@/stores/shared-media-preferences";

export interface PreJoinModalProps {
  visible: boolean;
  username: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function PreJoinModal({ visible, username, onCancel, onConfirm }: PreJoinModalProps) {
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible, onCancel]);

  if (!visible || typeof document === "undefined") return null;

  const prefs = getSharedMediaPreferences();
  const handleSubmit = (choices: LocalUserChoices) => {
    setSharedMediaPreferences({
      videoEnabled: choices.videoEnabled,
      audioEnabled: choices.audioEnabled,
      videoDeviceId: choices.videoDeviceId || null,
      audioDeviceId: choices.audioDeviceId || null,
    });
    onConfirm();
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        background: "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      data-lk-theme="default"
    >
      {/* Hide the username input (identity comes from auth) while keeping
          the Join button. Tint Join with Hubcode magenta. */}
      <style>{`
        .lk-prejoin .lk-username-container input,
        .lk-prejoin input[id="username"],
        .lk-prejoin input[name="username"] { display: none !important; }
        .lk-prejoin .lk-button.lk-join-button {
          background-color: #C4198B !important;
          border-color: #C4198B !important;
          color: #fff !important;
        }
        .lk-prejoin .lk-button.lk-join-button:hover {
          background-color: #a8137a !important;
        }
      `}</style>
      <div style={{ width: "min(640px, 92vw)" }}>
        <PreJoin
          defaults={{
            username,
            videoEnabled: prefs.videoEnabled,
            audioEnabled: prefs.audioEnabled,
            videoDeviceId: prefs.videoDeviceId ?? undefined,
            audioDeviceId: prefs.audioDeviceId ?? undefined,
          }}
          onSubmit={handleSubmit}
          joinLabel="Join session"
        />
      </div>
    </div>,
    document.body,
  );
}
