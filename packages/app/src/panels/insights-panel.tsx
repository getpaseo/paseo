import { Gauge } from "@/components/icons/ui-icons";
import { withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
import { InsightsContent } from "@/panels/insights/insights-content";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";

const ThemedGauge = withUnistyles(Gauge);

const insightsPanelPresentation = {
  label: (t) => t("panels.insights.label"),
  subtitle: (t) => t("panels.insights.subtitle"),
  tooltip: (t) => t("panels.insights.label"),
  icon: ThemedGauge,
} satisfies PanelPresentation;

function useInsightsPanelDescriptor(_target: { kind: "insights" }) {
  const { t } = useTranslation();
  const label = insightsPanelPresentation.label(t);
  return {
    label,
    subtitle: insightsPanelPresentation.subtitle(t),
    tooltip: label,
    titleState: "ready" as const,
    icon: insightsPanelPresentation.icon,
    statusBucket: null,
  };
}

function InsightsPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  invariant(target.kind === "insights", "InsightsPanel requires insights target");
  return <InsightsContent serverId={serverId} workspaceId={workspaceId} />;
}

export const insightsPanelRegistration = definePanel("insights", {
  component: InsightsPanel,
  presentation: insightsPanelPresentation,
  useDescriptor: useInsightsPanelDescriptor,
});
