import { useCallback } from "react";
import { useRouter } from "expo-router";
import { AddHostMethodModal } from "@/components/add-host-method-modal";
import { AddHostModal } from "@/components/add-host-modal";
import { AddRemoteSshHostModal } from "@/components/add-remote-ssh-host-modal";
import { PairLinkModal } from "@/components/pair-link-modal";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSettingsAddHostFlowStore } from "@/stores/settings-add-host-flow-store";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";

export function SettingsAddHostFlow() {
  const router = useRouter();
  const isCompactLayout = useIsCompactFormFactor();
  const step = useSettingsAddHostFlowStore((state) => state.step);
  const goTo = useSettingsAddHostFlowStore((state) => state.goTo);
  const close = useSettingsAddHostFlowStore((state) => state.close);

  const goBackToMethods = useCallback(() => goTo("method"), [goTo]);
  const selectDirectConnection = useCallback(() => goTo("direct"), [goTo]);
  const selectRemoteSsh = useCallback(() => goTo("remote-ssh"), [goTo]);
  const selectPasteLink = useCallback(() => goTo("paste-link"), [goTo]);

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
