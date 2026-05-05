import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Save } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { bytesToUtf8 } from "@/components/workspace-file-previews/bytes";
import type { WorkspaceDrawioPreviewProps } from "@/components/workspace-file-previews/types";

const DRAWIO_ORIGIN = "https://embed.diagrams.net";
const DRAWIO_TARGET_ORIGIN = "*";
const DRAWIO_URL =
  "https://embed.diagrams.net/?embed=1&proto=json&spin=1&ui=min&libraries=1&saveAndExit=0&noExitBtn=1";

function parseDrawioMessage(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function WorkspaceDrawioPreview({
  filePath,
  bytes,
  size,
  modifiedAt,
  onSave,
}: WorkspaceDrawioPreviewProps) {
  const { theme } = useUnistyles();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "saved" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const xml = useMemo(() => bytesToUtf8(bytes), [bytes]);
  const title = useMemo(() => filePath.split("/").findLast(Boolean) ?? filePath, [filePath]);

  const postToDrawio = useCallback((payload: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify(payload), DRAWIO_TARGET_ORIGIN);
  }, []);
  const handleSavePress = useCallback(() => {
    postToDrawio({ action: "save" });
  }, [postToDrawio]);
  const saveButtonStyle = useCallback(
    ({ hovered, pressed }: { hovered?: boolean; pressed?: boolean }) => [
      styles.saveButton,
      (hovered || pressed) && styles.saveButtonActive,
    ],
    [],
  );

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow && event.origin !== DRAWIO_ORIGIN) {
        return;
      }
      const payload = parseDrawioMessage(event.data);
      if (!payload) {
        return;
      }
      if (payload.event === "init") {
        postToDrawio({
          action: "load",
          autosave: 0,
          title,
          xml,
        });
        setStatus("ready");
        return;
      }
      if (payload.event !== "save") {
        return;
      }
      const nextXml = typeof payload.xml === "string" ? payload.xml : null;
      if (!nextXml) {
        return;
      }
      setStatus("saving");
      setError(null);
      void (async () => {
        try {
          await onSave({
            bytes: new TextEncoder().encode(nextXml),
            expectedModifiedAt: modifiedAt,
            expectedSize: size,
          });
          setStatus("saved");
          postToDrawio({ action: "status", message: "Saved", modified: false });
        } catch (saveError) {
          setStatus("error");
          setError(saveError instanceof Error ? saveError.message : "Failed to save diagram");
          postToDrawio({ action: "status", message: "Save failed", modified: true });
        }
      })();
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [modifiedAt, onSave, postToDrawio, size, title, xml]);

  const iframe = createElement("iframe", {
    ref: iframeRef,
    src: DRAWIO_URL,
    title,
    sandbox: "allow-scripts allow-forms allow-popups allow-downloads",
    style: {
      border: 0,
      flex: 1,
      height: "100%",
      width: "100%",
    },
  });

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <View style={styles.statusSlot}>
          {status === "loading" || status === "saving" ? <ActivityIndicator size="small" /> : null}
          <Text style={styles.statusText} numberOfLines={1}>
            {error ?? (status === "saved" ? "Saved" : "Draw.io")}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save diagram"
          onPress={handleSavePress}
          style={saveButtonStyle}
        >
          <Save size={14} color={theme.colors.foreground} />
          <Text style={styles.saveButtonText}>Save</Text>
        </Pressable>
      </View>
      <View style={styles.frame}>{iframe}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  toolbar: {
    height: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  statusSlot: {
    minWidth: 0,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  statusText: {
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  saveButton: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
  },
  saveButtonActive: {
    backgroundColor: theme.colors.surface2,
  },
  saveButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  frame: {
    flex: 1,
    minHeight: 0,
  },
}));
