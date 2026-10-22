import { useCallback, useState } from "react";
import { useRouter } from "expo-router";
import { AddHostMethodModal } from "@/components/add-host-method-modal";
import { AddHostModal } from "@/components/add-host-modal";
import { AddRemoteSshHostModal } from "@/components/add-remote-ssh-host-modal";
import { PairLinkModal } from "@/components/pair-link-modal";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSettingsAddHostFlowStore } from "@/stores/settings-add-host-flow-store";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";

type Step = "method" | "direct" | "remote-ssh" | "paste-link";

export function SettingsAddHostFlow() {
  const router = useRouter();
  const isCompactLayout = useIsCompactFormFactor();
  const request = useSettingsAddHostFlowStore((state) => state.request);
  const clearRequest = useSettingsAddHostFlowStore((state) => state.close);

  // The step is local, so leaving Settings unmounts it and a half-finished flow
  // cannot reopen later. Seeding from the request already present at mount
  // makes an unconsumed request from a previous visit a no-op.
  const [step, setStep] = useState<Step | null>(null);
  const [handledRequestId, setHandledRequestId] = useState(request?.id ?? 0);
  if (request && request.id !== handledRequestId) {
    setHandledRequestId(request.id);
    setStep("method");
  }

  const close = useCallback(() => {
    setStep(null);
    clearRequest();
  }, [clearRequest]);

  const goBackToMethods = useCallback(() => setStep("method"), []);
  const selectDirectConnection = useCallback(() => setStep("direct"), []);
  const selectRemoteSsh = useCallback(() => setStep("remote-ssh"), []);
  const selectPasteLink = useCallback(() => setStep("paste-link"), []);

  const handleScanQr = useCallback(() => {
    close();
    router.push({ pathname: "/pair-scan", params: { source: "settings" } });
  }, [close, router]);

  const handleHostAdded = useCallback(
    ({ serverId }: { serverId: string }) => {
      const target = buildSettingsHostSectionRoute(serverId, "connections");
      if (isCompactLayout) {
        router.push(target);
      } else {
        router.replace(target);
      }
    },
    [isCompactLayout, router],
  );

  return (
    <>
      <AddHostMethodModal
        visible={step === "method"}
        onClose={close}
        onDirectConnection={selectDirectConnection}
        onRemoteSsh={selectRemoteSsh}
        onPasteLink={selectPasteLink}
        onScanQr={handleScanQr}
      />
      <AddHostModal
        visible={step === "direct"}
        onClose={close}
        onCancel={goBackToMethods}
        onSaved={handleHostAdded}
      />
      <AddRemoteSshHostModal
        visible={step === "remote-ssh"}
        onClose={close}
        onCancel={goBackToMethods}
        onSaved={handleHostAdded}
      />
      <PairLinkModal
        visible={step === "paste-link"}
        onClose={close}
        onCancel={goBackToMethods}
        onSaved={handleHostAdded}
      />
    </>
  );
}
