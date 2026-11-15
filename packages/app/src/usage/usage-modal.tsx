import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { AdaptiveModalSheet, SheetHeaderSubtitle } from "@/components/adaptive-modal-sheet";
import { builtinSidebarNavLabelKey } from "@/sidebar-nav/model";
import { useHostUsageWithControls } from "./controls";
import { useUsageDisplay } from "./display";
import { getHostPickerLabel } from "@/components/hosts/host-picker";
import { hasHostChoice, useUsageHostSelection } from "./hosts";
import type { UsageHost } from "./model";
import { UsageBody, UsageMessage } from "./usage-section";

interface UsageModalProps {
  visible: boolean;
  onClose: () => void;
  onDismiss: () => void;
}

/**
 * Usage over the current screen: a dialog on wide layouts, a bottom sheet on compact ones. It
 * shows the usage host's reports with pins, and Refresh all and Settings in its title row. With more
 * than one host, the host shown is the title's subtitle, and Settings is where it is picked.
 */
export function UsageModal(props: UsageModalProps) {
  const { t } = useTranslation();
  const { serverId, connectedHosts, select } = useUsageHostSelection();
  if (!serverId) {
    return (
      <UsageModalFrame {...props}>
        <UsageMessage text={t("providerUsage.noHosts")} />
      </UsageModalFrame>
    );
  }
  return (
    <HostUsageModal {...props} serverId={serverId} hosts={connectedHosts} onSelectHost={select} />
  );
}

function HostUsageModal({
  serverId,
  hosts,
  onSelectHost,
  ...props
}: UsageModalProps & {
  serverId: string;
  hosts: UsageHost[];
  onSelectHost: (serverId: string) => void;
}) {
  const hostSelection = useMemo(
    () => ({ hosts, serverId, onSelect: onSelectHost }),
    [hosts, onSelectHost, serverId],
  );
  const { view, refresh, controls } = useHostUsageWithControls(hostSelection);
  const { display } = useUsageDisplay(view.kind === "ready" ? view.reports : []);
  const hostLabel = hasHostChoice(hostSelection)
    ? getHostPickerLabel(hostSelection.hosts, hostSelection.serverId)
    : undefined;
  return (
    <UsageModalFrame {...props} actions={controls} subtitle={hostLabel}>
      {/* Keyed by host so state the cards hold, such as a refresh in flight, never shows on another
        host's cards. The frame is not keyed: remounting it would dismiss a compact sheet, and Usage
        with it. */}
      <View key={serverId} testID={`usage-host-${serverId}`}>
        <UsageBody serverId={serverId} view={view} display={display} onRefresh={refresh} />
      </View>
    </UsageModalFrame>
  );
}

function UsageModalFrame({
  visible,
  onClose,
  onDismiss,
  actions,
  subtitle,
  children,
}: UsageModalProps & { actions?: ReactNode; subtitle?: string; children: ReactNode }) {
  const { t } = useTranslation();
  const title = t(builtinSidebarNavLabelKey("usage"));
  const header = useMemo(
    () => ({
      title,
      titleTestID: "usage-modal-title",
      subtitle: subtitle ? (
        <SheetHeaderSubtitle text={subtitle} testID="usage-modal-host" />
      ) : undefined,
      actions,
    }),
    [actions, subtitle, title],
  );
  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      desktopMaxWidth={640}
      contextBridge={null}
      testID="usage-modal"
    >
      <View testID="usage-modal-body">{children}</View>
    </AdaptiveModalSheet>
  );
}
