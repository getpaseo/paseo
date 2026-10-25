import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SettingsSection, SettingsCard, SettingsSelect } from "@/components/settings";
import {
  useAppSettings,
  type OpenInSidePanePreferences,
  type PullRequestOpenLocation,
  type ServiceUrlBehavior,
  type TerminalOpenLocation,
} from "@/hooks/use-settings";

const SOURCES = [
  "explorerFiles",
  "diffs",
  "chatFiles",
  "diffFiles",
  "subagents",
] as const satisfies readonly (keyof OpenInSidePanePreferences)[];

const SERVICE_URL_BEHAVIORS: readonly ServiceUrlBehavior[] = ["ask", "in-app", "external"];

const TERMINAL_DESTINATIONS: readonly TerminalOpenLocation[] = ["main", "side", "bottom"];
const MAIN_AND_SIDE_DESTINATIONS: readonly OpenLocationDestination[] = ["main", "side"];
const PULL_REQUEST_DESTINATIONS: readonly OpenLocationDestination[] = ["main", "side", "explorer"];

const SERVICE_URL_LABEL_KEYS: Record<ServiceUrlBehavior, string> = {
  ask: "settings.general.serviceUrls.options.ask",
  "in-app": "settings.general.serviceUrls.options.inApp",
  external: "settings.general.serviceUrls.options.external",
};

type OpenLocationSource = keyof OpenInSidePanePreferences | "pullRequests" | "terminal";
type OpenLocationDestination = PullRequestOpenLocation | "bottom";

function OpenLocationRow({
  source,
  destination,
  destinations,
  onDestinationChange,
}: {
  source: OpenLocationSource;
  destination: OpenLocationDestination;
  destinations: readonly OpenLocationDestination[];
  onDestinationChange(source: OpenLocationSource, destination: OpenLocationDestination): void;
}) {
  const { t } = useTranslation();
  const options = useMemo(
    () =>
      destinations.map((value) => ({
        value,
        label: t(`settings.layout.openInSidePane.destinations.${value}`),
      })),
    [destinations, t],
  );
  const change = useCallback(
    (value: OpenLocationDestination) => onDestinationChange(source, value),
    [source, onDestinationChange],
  );
  return (
    <SettingsSelect
      label={t(`settings.layout.openInSidePane.sources.${source}.label`)}
      value={destination}
      options={options}
      onValueChange={change}
    />
  );
}

function ServiceUrlRow() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const options = useMemo(
    () =>
      SERVICE_URL_BEHAVIORS.map((value) => ({ value, label: t(SERVICE_URL_LABEL_KEYS[value]) })),
    [t],
  );
  const change = useCallback(
    (serviceUrlBehavior: ServiceUrlBehavior) => void updateSettings({ serviceUrlBehavior }),
    [updateSettings],
  );
  return (
    <SettingsSelect
      label={t("settings.layout.openInSidePane.sources.serviceUrls.label")}
      value={settings.serviceUrlBehavior}
      options={options}
      onValueChange={change}
    />
  );
}

/** Where things open: files, diffs, subagents, pull requests, and script URLs. Desktop only. */
export function OpenLocationSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const handleDestinationChange = useCallback(
    (source: OpenLocationSource, destination: OpenLocationDestination) => {
      if (source === "pullRequests") {
        if (destination === "bottom") {
          return;
        }
        void updateSettings({ pullRequestOpenLocation: destination });
        return;
      }
      if (source === "terminal") {
        if (destination === "explorer") {
          return;
        }
        void updateSettings({ terminalOpenLocation: destination });
        return;
      }
      void updateSettings({
        openInSidePane: { ...settings.openInSidePane, [source]: destination === "side" },
      });
    },
    [settings.openInSidePane, updateSettings],
  );
  return (
    <SettingsSection title={t("settings.layout.openInSidePane.title")}>
      <SettingsCard>
        {SOURCES.map((source) => (
          <OpenLocationRow
            key={source}
            source={source}
            destination={settings.openInSidePane[source] ? "side" : "main"}
            destinations={MAIN_AND_SIDE_DESTINATIONS}
            onDestinationChange={handleDestinationChange}
          />
        ))}
        <OpenLocationRow
          source="terminal"
          destination={settings.terminalOpenLocation}
          destinations={TERMINAL_DESTINATIONS}
          onDestinationChange={handleDestinationChange}
        />
        <OpenLocationRow
          source="pullRequests"
          destination={settings.pullRequestOpenLocation}
          destinations={PULL_REQUEST_DESTINATIONS}
          onDestinationChange={handleDestinationChange}
        />
        <ServiceUrlRow />
      </SettingsCard>
    </SettingsSection>
  );
}
