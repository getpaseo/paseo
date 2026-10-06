import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { builtinSidebarNavLabelKey } from "@/sidebar-nav/model";
import { useHostUsageWithControls } from "./controls";
import { usageCopy } from "./copy";
import { useUsagePreferences } from "./display";
import { useUsageHostSelection } from "./hosts";
import type { UsageHost } from "./model";
import { UsageBody, UsageMessage } from "./usage-section";

interface UsageModalProps {
  visible: boolean;
  onClose: () => void;
  onDismiss: () => void;
}

/**
 * Usage over the current screen: a dialog on wide layouts, a bottom sheet on compact ones. It
 * shows the usage host's reports with pins, and the host filter, Refresh all, and Settings in its
 * title row.
 */
export function UsageModal(props: UsageModalProps) {
  const { serverId, connectedHosts, select } = useUsageHostSelection();
  if (!serverId) {
    return (
      <UsageModalFrame {...props}>
        <UsageMessage text={usageCopy.noHosts} />
      </UsageModalFrame>
    );
  }
  // Keyed by host so a refresh in flight on one host never shows on another's cards.
  return (
    <HostUsageModal
      key={serverId}
      {...props}
      serverId={serverId}
      hosts={connectedHosts}
      onSelectHost={select}
    />
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
  const { display } = useUsagePreferences();
  const hostSelection = useMemo(
    () => ({ hosts, serverId, onSelect: onSelectHost }),
    [hosts, onSelectHost, serverId],
  );
  const { view, refresh, controls } = useHostUsageWithControls(hostSelection);
  return (
    <UsageModalFrame {...props} actions={controls}>
      <View testID={`usage-host-${serverId}`}>
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
  children,
}: UsageModalProps & { actions?: ReactNode; children: ReactNode }) {
  const { t } = useTranslation();
  const title = t(builtinSidebarNavLabelKey("usage"));
  const header = useMemo(() => ({ title, actions }), [actions, title]);
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
