import { createContext, useCallback, useContext, useState, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { AddHostMethodModal } from "./internal/add-host-method-modal";
import { AddHostModal } from "./internal/add-host-modal";
import { AddRemoteSshHostModal } from "./internal/add-remote-ssh-host-modal";
import { PairLinkModal } from "./internal/pair-link-modal";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { PairScanContent } from "./internal/scan";
import { createAddHostFlow, type AddHostOptions, type AddHostSession } from "./internal/model";

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
