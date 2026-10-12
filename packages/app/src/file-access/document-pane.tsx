import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import { materializeFile } from "./materialize";
import type { FileAccessTarget, MaterializedFile } from "./types";
import { PdfView } from "./pdf/view";
import { documentKind } from "./types";

export function DocumentPane({ target }: { target: FileAccessTarget }) {
  const { t } = useTranslation();
  const stableTarget = useMemo(
    () => ({ serverId: target.serverId, cwd: target.cwd, path: target.path }),
    [target.serverId, target.cwd, target.path],
  );
  const client = useSessionStore((state) => state.sessions[target.serverId]?.client ?? null);
  const supportsConversion = useSessionStore(
    (state) => state.sessions[target.serverId]?.serverInfo?.features?.documentPreviews === true,
  );
  const [file, setFile] = useState<MaterializedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ received: 0, total: 0 });
  const [revision, setRevision] = useState(0);
  const [controller, setController] = useState<AbortController | null>(null);
  const cancel = useCallback(() => controller?.abort(), [controller]);
  const retry = useCallback(() => setRevision((current) => current + 1), []);
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    let result: MaterializedFile | null = null;
    setController(abort);
    setError(null);
    setFile(null);
    setProgress({ received: 0, total: 0 });
    const prepare = async () => {
      let readTarget = stableTarget;
      if (documentKind(stableTarget.path) === "word") {
        if (!client?.isConnected) throw new Error(t("fileAccess.disconnected"));
        if (!supportsConversion) throw new Error(t("fileAccess.updateHost"));
        const converted = await client.createDocumentPreview(stableTarget.cwd, stableTarget.path);
        if (converted.error) throw new Error(converted.error);
        readTarget = { serverId: stableTarget.serverId, cwd: converted.cwd, path: converted.path };
      }
      if (abort.signal.aborted) throw new Error("File transfer canceled");
      return materializeFile({
        client,
        target: readTarget,
        maxBytes: 50 * 1024 * 1024,
        signal: abort.signal,
        onProgress: (received, total) => {
          if (active) setProgress({ received, total });
        },
      });
    };
    void prepare()
      .then((value) => {
        if (abort.signal.aborted) {
          value.release();
          return;
        }
        result = value;
        setFile(value);
        return value;
      })
      .catch((cause) => {
        if (active) {
          const message = cause instanceof Error ? cause.message : t("fileAccess.failed");
          let display = message;
          if (/too large|50 MiB limit/i.test(message)) display = t("fileAccess.previewBudget");
          else if (abort.signal.aborted) display = t("fileAccess.canceled");
          setError(display);
        }
      });
    return () => {
      active = false;
      abort.abort();
      result?.release();
    };
  }, [client, supportsConversion, stableTarget, revision, t]);
  if (file)
    return (
      <View style={styles.viewer}>
        {file.offline ? <Text style={styles.text}>{t("fileAccess.offline")}</Text> : null}
        {documentKind(target.path) === "word" ? (
          <Text style={styles.text}>{t("fileAccess.converted")}</Text>
        ) : null}
        <PdfView uri={file.uri} />
      </View>
    );
  return (
    <View style={styles.center}>
      <Text style={styles.text}>
        {error ??
          t("fileAccess.downloading", {
            received: formatBytes(progress.received),
            total: formatBytes(progress.total),
          })}
      </Text>
      {error ? (
        <Button variant="outline" onPress={retry}>
          {t("fileAccess.retry")}
        </Button>
      ) : (
        <Button variant="ghost" onPress={cancel}>
          {t("fileAccess.cancel")}
        </Button>
      )}
    </View>
  );
}
function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
const styles = StyleSheet.create((theme) => ({
  viewer: { flex: 1, minHeight: 0 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  text: { color: theme.colors.foregroundMuted },
}));
