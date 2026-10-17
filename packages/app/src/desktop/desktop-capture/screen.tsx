import { createCaptureSubmitter, type CaptureSubmission } from "./submit";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  DesktopCaptureDraftSchema,
  type DesktopCaptureDraft,
} from "@getpaseo/protocol/desktop-capture";
import { getDesktopHost } from "@/desktop/host";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";
import { connectionFromListen } from "@/types/host-connection";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { useDictation } from "@/hooks/use-dictation";
import { DraftAgentControls } from "@/composer/agent-controls";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { persistAttachmentFromDataUrl } from "@/attachments/service";
import { getAttachmentStore } from "@/attachments/store";
import { getDesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";
import { DesktopControlHost } from "./control-host";
import { useStableEvent } from "@/hooks/use-stable-event";
import { CaptureCanvas } from "./canvas";

export function DesktopCaptureScreen() {
  const bridge = getDesktopHost()?.desktopCapture;
  const [host, setHost] = useState<{ serverId: string; deviceId: string } | null>(null);
  const [capture, setCapture] = useState<DesktopCaptureDraft | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!bridge) return;
    const accept = (value: unknown) => {
      if (value) setCapture(DesktopCaptureDraftSchema.parse(value));
      else setCapture(null);
    };
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const prepareHost = async () => {
      try {
        const [status, deviceId] = await Promise.all([getDesktopDaemonStatus(), bridge.device()]);
        if (disposed) return;
        if (status.status === "running" && status.serverId && status.listen) {
          const runtime = getHostRuntimeStore();
          await runtime.boot();
          const connection = connectionFromListen(status.listen);
          if (!connection) throw new Error("Local connection unavailable");
          const local = runtime.getHosts().find((entry) => entry.serverId === status.serverId);
          if (!local?.connections.some((entry) => entry.id === connection.id)) {
            const registered = await runtime.probeAndUpsertConnection({
              connection,
              timeoutMs: 5000,
            });
            if (registered.serverId !== status.serverId) throw new Error("Local daemon changed");
          }
          if (!disposed) {
            setHost({ serverId: status.serverId, deviceId });
            setError("");
          }
        } else timer = setTimeout(() => void prepareHost(), 1000);
      } catch {
        if (!disposed) {
          setError("Connexion à Paseo indisponible.");
          timer = setTimeout(() => void prepareHost(), 1000);
        }
      }
    };
    void prepareHost();
    const off = bridge.onUpdate(accept);
    void bridge
      .getDraft()
      .then(accept)
      .catch(() => setError("Capture indisponible."));
    return () => {
      disposed = true;
      clearTimeout(timer);
      off();
    };
  }, [bridge]);
  if (!bridge) return null;
  return (
    <>
      {host ? <DesktopControlHost serverId={host.serverId} deviceId={host.deviceId} /> : null}
      {capture ? (
        <CaptureRequest key={capture.id} capture={capture} />
      ) : (
        <View style={styles.page}>
          <Text style={styles.text}>{error || "Prêt à capturer"}</Text>
        </View>
      )}
    </>
  );
}

function CaptureRequest({ capture }: { capture: DesktopCaptureDraft }) {
  const bridge = getDesktopHost()!.desktopCapture!;
  const client = useHostRuntimeClient(capture.serverId);
  const connected = useHostRuntimeIsConnected(capture.serverId);
  const draft = useAgentInputDraft({
    draftKey: `desktop-capture:${capture.id}`,
    composer: { initialServerId: capture.serverId, isVisible: true },
  });
  const text = useSyncExternalStore(
    draft.textSource.subscribe,
    draft.textSource.getSnapshot,
    draft.textSource.getSnapshot,
  );
  const editor = useRef<EditingTextInputHandle>(null);
  const [mode, setMode] = useState<"rectangle" | "pen">("rectangle");
  const [images, setImages] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [complete, setComplete] = useState(false);
  const active = useRef(false);
  const attempt = useRef<CaptureSubmission | null>(null);
  const submitter = useRef(createCaptureSubmitter());
  const form = draft.composerState;
  const cancel = useStableEvent(() => {
    if (active.current) return;
    void dictation.cancelDictation();
    draft.clear("abandoned");
    void bridge.cancel();
  });
  useEffect(() => {
    if (!isWeb) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [cancel]);
  async function submit() {
    if (active.current || !client || !connected || !form || !form.selectedProvider) return;
    active.current = true;
    setBusy(true);
    setError("");
    setAttempted(true);
    try {
      if (!attempt.current) {
        const store = await getAttachmentStore();
        const encoded = [];
        const attachments = [];
        for (let index = 0; index < images.length; index++) {
          const metadata = await persistAttachmentFromDataUrl({
            dataUrl: images[index],
            mimeType: "image/png",
            fileName: index === 0 ? "capture.png" : "zone.png",
          });
          attachments.push({ kind: "image" as const, metadata });
          encoded.push({
            data: await store.encodeBase64({ attachment: metadata }),
            mimeType: "image/png",
          });
        }
        draft.setAttachments(attachments);
        attempt.current = {
          key: capture.id,
          deviceId: capture.deviceId,
          text: draft.textSource.getSnapshot(),
          ocr: capture.ocr,
          context: capture.context,
          autoModel: form.modelRouting === "jev",
          launchProfileId: form.selectedLaunchProfileId,
          config: {
            provider: `${form.selectedProvider}/${form.effectiveModelId}`,
            modeId: form.selectedMode,
            thinkingOptionId: form.effectiveThinkingOptionId,
            featureValues: form.featureValues,
          },
          images: encoded,
        };
      }
      const result = await submitter.current(client, attempt.current, bridge.ensurePara);
      await bridge.complete({
        serverId: capture.serverId,
        workspaceId: result.workspaceId,
        agentId: result.agentId,
      });
      draft.clear("sent");
      setComplete(true);
    } catch {
      setError("Envoi non confirmé. Réessayez pour retrouver la même demande.");
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  const open = useCallback(() => {
    void bridge.open();
  }, [bridge]);
  const close = useCallback(() => {
    void bridge.cancel();
  }, [bridge]);
  const rectangle = useCallback(() => setMode("rectangle"), []);
  const pen = useCallback(() => setMode("pen"), []);
  const send = useStableEvent(() => {
    void submit();
  });
  const transcript = useStableEvent((value: string) => {
    const before = draft.textSource.getSnapshot();
    draft.replaceText([before, value].filter(Boolean).join(" "));
  });
  const dictationError = useStableEvent(() =>
    setError("Micro indisponible. Vous pouvez écrire votre demande."),
  );
  const dictation = useDictation({
    client,
    onTranscript: transcript,
    onError: dictationError,
    canStart: () => connected && !attempted,
  });
  const microphone = useStableEvent(() => {
    if (dictation.isRecording) void dictation.confirmDictation();
    else void dictation.startDictation();
  });
  useEffect(() => {
    editor.current?.replaceText(draft.textReplacement.text);
  }, [draft.textReplacement]);
  if (complete)
    return (
      <View style={styles.page}>
        <Text style={styles.text}>Agent créé</Text>
        <Button onPress={open}>Ouvrir dans Paseo</Button>
        <Button variant="ghost" onPress={close}>
          Fermer
        </Button>
      </View>
    );
  return (
    <View style={styles.page}>
      <ScrollView style={styles.preview}>
        <CaptureCanvas png={capture.png} mode={mode} disabled={attempted} onChange={setImages} />
      </ScrollView>
      <View style={styles.actions}>
        <Button
          variant={mode === "rectangle" ? "secondary" : "ghost"}
          disabled={attempted}
          onPress={rectangle}
        >
          Rectangle
        </Button>
        <Button variant={mode === "pen" ? "secondary" : "ghost"} disabled={attempted} onPress={pen}>
          Crayon
        </Button>
        <Button variant="ghost" disabled={busy} onPress={cancel}>
          Annuler
        </Button>
      </View>
      {!connected && <Text style={styles.text}>Connexion à Paseo…</Text>}
      {error ? (
        <Text accessibilityRole="alert" style={styles.text}>
          {error}
        </Text>
      ) : null}
      <>
        <EditingTextInput
          ref={editor}
          initialValue={text}
          onChangeText={draft.editText}
          editable={!attempted}
          multiline
          autoFocus
          accessibilityLabel="Votre demande"
          placeholder="Que voulez-vous faire ?"
          style={styles.input}
        />
        <View style={styles.actions}>
          {!attempted && form ? <DraftAgentControls {...form.agentControls} /> : null}
          {!attempted ? (
            <Button
              variant="ghost"
              disabled={!connected || dictation.isProcessing}
              onPress={microphone}
            >
              {dictation.isRecording ? "Terminer" : "Dicter"}
            </Button>
          ) : null}
          <Button
            disabled={
              !connected ||
              !draft.isHydrated ||
              !form?.selectedProvider ||
              !images.length ||
              !text.trim() ||
              dictation.isRecording ||
              dictation.isProcessing
            }
            loading={busy}
            onPress={send}
          >
            {attempted && !busy ? "Réessayer" : "Envoyer"}
          </Button>
        </View>
      </>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
  },
  preview: { flex: 1 },
  input: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    minHeight: theme.spacing[16],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
  },
  actions: { flexDirection: "row", gap: theme.spacing[2], alignItems: "center" },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
}));
