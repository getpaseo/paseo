import { Camera } from "@/components/icons/ui-icons";
import { withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
import { EvidenceContent } from "@/panels/evidence/evidence-content";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";

const ThemedCamera = withUnistyles(Camera);

const evidencePanelPresentation = {
  label: (t) => t("panels.evidence.label"),
  subtitle: (t) => t("panels.evidence.subtitle"),
  tooltip: (t) => t("panels.evidence.label"),
  icon: ThemedCamera,
} satisfies PanelPresentation;

function useEvidencePanelDescriptor(_target: { kind: "evidence" }) {
  const { t } = useTranslation();
  const label = evidencePanelPresentation.label(t);
  return {
    label,
    subtitle: evidencePanelPresentation.subtitle(t),
    tooltip: label,
    titleState: "ready" as const,
    icon: evidencePanelPresentation.icon,
    statusBucket: null,
  };
}

function EvidencePanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  invariant(target.kind === "evidence", "EvidencePanel requires evidence target");
  return <EvidenceContent serverId={serverId} workspaceId={workspaceId} />;
}

export const evidencePanelRegistration = definePanel("evidence", {
  component: EvidencePanel,
  presentation: evidencePanelPresentation,
  useDescriptor: useEvidencePanelDescriptor,
});
