import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { Alert } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { providerUsageCopy } from "./copy";
import type { ProviderUsage } from "./types";

interface ProviderUsageVisibilitySectionProps {
  providers: readonly ProviderUsage[];
  hiddenProviderIds: readonly string[];
  isConfigLoading: boolean;
  onVisibilityChange: (providerId: string, visible: boolean) => Promise<void>;
}

interface ProviderUsageVisibilityRowProps {
  provider: ProviderUsage;
  bordered: boolean;
  visible: boolean;
  disabled: boolean;
  onChange: (input: { providerId: string; visible: boolean }) => void;
}

function ProviderUsageVisibilityRow({
  provider,
  bordered,
  visible,
  disabled,
  onChange,
}: ProviderUsageVisibilityRowProps) {
  const handleValueChange = useCallback(
    (next: boolean) => onChange({ providerId: provider.providerId, visible: next }),
    [onChange, provider.providerId],
  );

  return (
    <View style={[settingsStyles.row, bordered ? settingsStyles.rowBorder : null]}>
      <Text style={settingsStyles.rowTitle} numberOfLines={1}>
        {provider.displayName}
      </Text>
      <Switch
        value={visible}
        onValueChange={handleValueChange}
        disabled={disabled}
        accessibilityLabel={providerUsageCopy.showProvider(provider.displayName)}
        testID={`provider-usage-visibility-${provider.providerId}`}
      />
    </View>
  );
}

export function ProviderUsageVisibilitySection({
  providers,
  hiddenProviderIds,
  isConfigLoading,
  onVisibilityChange,
}: ProviderUsageVisibilitySectionProps) {
  const mutation = useMutation({
    mutationFn: async (input: { providerId: string; visible: boolean }) => {
      await onVisibilityChange(input.providerId, input.visible);
    },
  });
  const hiddenProviders = new Set(hiddenProviderIds);

  if (providers.length === 0) return null;

  return (
    <SettingsSection
      title={providerUsageCopy.shownProvidersTitle}
      testID="provider-usage-visibility-card"
    >
      <View style={settingsStyles.card}>
        {providers.map((provider, index) => {
          const visible = !hiddenProviders.has(provider.providerId);
          return (
            <ProviderUsageVisibilityRow
              key={provider.providerId}
              provider={provider}
              bordered={index > 0}
              visible={visible}
              disabled={isConfigLoading || mutation.isPending}
              onChange={mutation.mutate}
            />
          );
        })}
      </View>
      {mutation.error ? (
        <Alert
          variant="error"
          title={providerUsageCopy.updateVisibilityError}
          description={
            mutation.error instanceof Error ? mutation.error.message : String(mutation.error)
          }
        />
      ) : null}
    </SettingsSection>
  );
}
