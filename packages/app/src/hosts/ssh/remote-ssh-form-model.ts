import { parseSshTransportUri } from "@getpaseo/protocol/ssh-transport";
import type { HostMutations } from "@/runtime/host-runtime";
import { DaemonConnectionTestError } from "@/utils/daemon-connection-error";
import {
  saveImportedSshHost,
  type ImportedPrivateKey,
  type SshKeyImportBridge,
} from "./ssh-key-import-model";

type ProbeSshHost = HostMutations["probeAndUpsertRemoteSshConnection"];
export type SavedSshHost = Awaited<ReturnType<ProbeSshHost>>;
type FormError =
  | { kind: "targetRequired" | "invalidTarget" | "keyRequired" | "unableToSave" }
  | { kind: "connectionFailed" | "importFailed"; detail: string };

export interface RemoteSshFormState {
  phase: "idle" | "importing" | "inspecting" | "saving";
  keyName: string | null;
  fingerprint: string | null;
  isPasswordVisible: boolean;
  error: FormError | null;
}

interface RemoteSshFormSnapshot {
  keyImport: {
    bridge: SshKeyImportBridge;
    importPrivateKey: () => Promise<ImportedPrivateKey | null>;
  } | null;
  probeHost: ProbeSshHost;
}

export interface RemoteSshFormModel {
  getState: () => RemoteSshFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  setTarget: (value: string) => void;
  setPassword: (value: string) => void;
  setPassphrase: (value: string) => void;
  togglePasswordVisibility: () => void;
  importKey: () => Promise<void>;
  submit: () => Promise<SavedSshHost | null>;
}

/** Own one open form's credentials and async lifetime. Closing fences late picker/probe results. */
export function openRemoteSshForm(snapshot: RemoteSshFormSnapshot): RemoteSshFormModel {
  let closed = false;
  let target = "";
  let password = "";
  let privateKey = "";
  let passphrase = "";
  const listeners = new Set<() => void>();
  let state: RemoteSshFormState = {
    phase: "idle",
    keyName: null,
    fingerprint: null,
    isPasswordVisible: false,
    error: null,
  };

  function publish(patch: Partial<RemoteSshFormState>) {
    if (closed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  /** The probe invokes this immediately before publishing the host, including on desktop. */
  function requireOpen() {
    if (closed) throw new Error("SSH setup was cancelled.");
  }

  return {
    getState: () => state,
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      target = "";
      password = "";
      privateKey = "";
      passphrase = "";
      listeners.clear();
    },
    setTarget(value) {
      if (closed || state.phase !== "idle") return;
      target = value;
      publish({ fingerprint: null });
    },
    setPassword(value) {
      if (!closed && state.phase === "idle") password = value;
    },
    setPassphrase(value) {
      if (closed || state.phase !== "idle") return;
      passphrase = value;
      publish({ fingerprint: null });
    },
    togglePasswordVisibility() {
      if (!closed && state.phase === "idle")
        publish({ isPasswordVisible: !state.isPasswordVisible });
    },
    async importKey() {
      if (closed || state.phase !== "idle" || !snapshot.keyImport) return;
      publish({ phase: "importing", error: null });
      try {
        const imported = await snapshot.keyImport.importPrivateKey();
        if (closed || !imported) return;
        privateKey = imported.text;
        publish({ keyName: imported.name, fingerprint: null });
      } catch (error) {
        publish({
          error:
            error instanceof Error
              ? { kind: "importFailed", detail: error.message }
              : { kind: "unableToSave" },
        });
      } finally {
        publish({ phase: "idle" });
      }
    },
    async submit() {
      if (closed || state.phase !== "idle") return null;
      if (!target.trim()) {
        publish({ error: { kind: "targetRequired" } });
        return null;
      }
      let parsed: ReturnType<typeof parseSshTransportUri>;
      try {
        parsed = parseSshTransportUri(target.trim());
      } catch {
        publish({ error: { kind: "invalidTarget" } });
        return null;
      }
      const keyImport = snapshot.keyImport;
      if (keyImport && !privateKey) {
        publish({ error: { kind: "keyRequired" } });
        return null;
      }

      const inspect = keyImport && !state.fingerprint;
      publish({ phase: inspect ? "inspecting" : "saving", error: null });
      try {
        if (inspect) {
          const observed = await keyImport.bridge.inspect(parsed, privateKey, passphrase);
          publish({ fingerprint: observed });
          return null;
        }
        // Capture this attempt's inputs before awaiting. Closing clears the model's references.
        const daemonPassword = password === "" ? undefined : password;
        async function saveHost(commit?: () => Promise<void>) {
          requireOpen();
          return snapshot.probeHost({
            ...parsed,
            password: daemonPassword,
            beforeSave: async () => {
              requireOpen();
              // Once durable commit begins, finish publishing the host even if dismissed.
              // Rejecting afterward would leave committed credentials without a saved host.
              await commit?.();
            },
          });
        }
        const result =
          keyImport && state.fingerprint
            ? await saveImportedSshHost({
                bridge: keyImport.bridge,
                approved: {
                  target: parsed,
                  privateKey,
                  passphrase,
                  fingerprint: state.fingerprint,
                },
                saveHost,
              })
            : await saveHost();
        if (closed) return null;
        privateKey = "";
        passphrase = "";
        password = "";
        return result;
      } catch (error) {
        publish({
          error:
            error instanceof Error && (keyImport || error instanceof DaemonConnectionTestError)
              ? { kind: "connectionFailed", detail: error.message }
              : { kind: "unableToSave" },
        });
        return null;
      } finally {
        publish({ phase: "idle" });
      }
    },
  };
}
