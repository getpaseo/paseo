import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import * as Linking from "expo-linking";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { AddHostMethodModal } from "./internal/add-host-method-modal";
import { AddHostModal } from "./internal/add-host-modal";
import { AddRemoteSshHostModal } from "./internal/add-remote-ssh-host-modal";
import { PairLinkModal } from "./internal/pair-link-modal";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { PairScanContent } from "./internal/scan";
import { createAddHostFlow, type AddHostOptions, type AddHostSession } from "./internal/model";
import { openPairingLinks } from "./internal/opened-link-model";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

const Context = createContext<ReturnType<typeof createAddHostFlow> | null>(null);

/** Owns the flow outside screen and appearance lifetimes. Callers own success navigation. */
export function AddHostProvider({ children }: { children: ReactNode }) {
  const [flow] = useState(createAddHostFlow);
  return <Context.Provider value={flow}>{children}</Context.Provider>;
}

export function AddHostFlowHost() {
  const flow = useContext(Context);
  if (!flow) throw new Error("AddHostFlowHost requires AddHostProvider");
  const session = useStore(flow.store, (state) => state.session);
  return session ? <AddHostSessionView key={session.id} session={session} /> : null;
}

export function useAddHost({ method, onAdded }: AddHostOptions = {}) {
  const flow = useContext(Context);
  if (!flow) throw new Error("useAddHost requires AddHostProvider");
  return useCallback(() => flow.open({ method, onAdded }), [flow, method, onAdded]);
}

/**
 * Saves the hosts of the pairing links the app is opened with, and asks for a
 * host's password when its first connection is rejected for one. Callers own
 * success navigation.
 */
export function OpenedPairingLinks({ onImported }: { onImported: (serverId: string) => void }) {
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;
  const [links] = useState(() => {
    const store = getHostRuntimeStore();
    return openPairingLinks({
      importConnectionLink: (link) => store.importConnectionLink(link, "openProject"),
      beginLinkPairing: () => store.beginLinkPairing(),
      getSnapshot: (serverId) => store.getSnapshot(serverId),
      subscribeToHost: (serverId, listener) => store.subscribe(serverId, listener),
      onImported: (serverId) => onImportedRef.current(serverId),
    });
  });
  const state = useSyncExternalStore(links.subscribe, links.getState, links.getState);

  useEffect(() => {
    void Linking.getInitialURL()
      .then((url) => links.open(url))
      .catch(() => undefined);
    const subscription = Linking.addEventListener("url", (event) => links.open(event.url));
    return () => {
      subscription.remove();
      links.close();
    };
  }, [links]);

  return (
    <PairLinkModal
      visible={state.status === "passwordRequired"}
      passwordRequired={state.status === "passwordRequired" ? state.passwordRequired : undefined}
      onClose={links.closePassword}
    />
  );
}

function AddHostSessionView({ session }: { session: AddHostSession }) {
  const { t } = useTranslation();
  const method = useStore(session.step, (state) => state.method);
  const back = useCallback(() => session.choose(null), [session]);
  const direct = useCallback(() => session.choose("direct"), [session]);
  const ssh = useCallback(() => session.choose("ssh"), [session]);
  const link = useCallback(() => session.choose("link"), [session]);
  const scan = useCallback(() => session.choose("scan"), [session]);
  const scanned = useCallback((serverId: string) => session.complete({ serverId }), [session]);
  const header = useMemo(
    () => ({ title: t("pairing.scan.title"), back: { onPress: back } }),
    [t, back],
  );
  return (
    <>
      <AddHostMethodModal
        visible={method === null}
        onClose={session.close}
        onDirectConnection={direct}
        onRemoteSsh={ssh}
        onPasteLink={link}
        onScanQr={scan}
      />
      <AddHostModal
        visible={method === "direct"}
        onClose={session.close}
        onCancel={back}
        onSaved={session.complete}
      />
      <AddRemoteSshHostModal
        visible={method === "ssh"}
        onClose={session.close}
        onCancel={back}
        onSaved={session.complete}
      />
      <PairLinkModal
        visible={method === "link"}
        onClose={session.close}
        onCancel={back}
        onSaved={session.complete}
      />
      {method === "scan" ? (
        <AdaptiveModalSheet
          header={header}
          visible
          onClose={session.close}
          scrollable={false}
          snapPoints={SCAN_SNAP_POINTS}
          desktopHeight="85%"
        >
          <PairScanContent onConnected={scanned} onClose={back} />
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}
const SCAN_SNAP_POINTS = ["90%"];
