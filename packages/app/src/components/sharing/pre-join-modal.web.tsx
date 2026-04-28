import "@livekit/components-styles";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { PreJoin, type LocalUserChoices } from "@livekit/components-react";
import { useUnistyles } from "react-native-unistyles";
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
  const { theme } = useUnistyles();
  const isLight = theme.colorScheme === "light";
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
        background: isLight ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      // LiveKit only ships a dark `default` theme; when the app is in light
      // mode we override the relevant CSS variables below to keep the modal
      // readable instead of leaving it dark-on-light.
      data-lk-theme="default"
    >
      {/* Hide the username input (identity comes from auth) while keeping
          the Join button. Tint Join with Hubcode magenta, and override
          LiveKit's dark surface/text tokens when we're in light mode. */}
      <style>{`
        .lk-prejoin .lk-username-container input,
        .lk-prejoin input[id="username"],
        .lk-prejoin input[name="username"] { display: none !important; }
        .lk-prejoin .lk-button.lk-join-button {
          background-color: ${theme.colors.brandMagenta} !important;
          border-color: ${theme.colors.brandMagenta} !important;
          color: #fff !important;
        }
        .lk-prejoin .lk-button.lk-join-button:hover {
          background-color: ${theme.colors.brandMagentaHover} !important;
        }
        ${
          isLight
            ? `
        .lk-prejoin {
          --lk-bg: ${theme.colors.surface1};
          --lk-bg2: ${theme.colors.surface2};
          --lk-fg: ${theme.colors.foreground};
          --lk-fg2: ${theme.colors.foregroundMuted};
          --lk-control-bg: ${theme.colors.surface2};
          --lk-control-fg: ${theme.colors.foreground};
          --lk-border-color: ${theme.colors.border};
          background-color: ${theme.colors.surface1} !important;
          color: ${theme.colors.foreground} !important;
          border-radius: 12px;
          border: 1px solid ${theme.colors.border};
        }
        .lk-prejoin .lk-video-container,
        .lk-prejoin .lk-camera-off-note {
          background-color: ${theme.colors.surface2} !important;
          color: ${theme.colors.foregroundMuted} !important;
        }
        .lk-prejoin .lk-button-group,
        .lk-prejoin .lk-button:not(.lk-join-button) {
          background-color: ${theme.colors.surface2} !important;
          color: ${theme.colors.foreground} !important;
          border-color: ${theme.colors.border} !important;
        }
        .lk-prejoin select,
        .lk-prejoin .lk-device-menu {
          background-color: ${theme.colors.surface1} !important;
          color: ${theme.colors.foreground} !important;
          border-color: ${theme.colors.border} !important;
        }
        `
            : ""
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
