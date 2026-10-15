import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { installRpc } from "../shared/rpc";

export function WorkflowSettings() {
  const install = useRpc(installRpc);
  const mutation = useMutation({ mutationFn: () => install({}) });
  const installProfiles = useCallback(() => mutation.mutate(), [mutation]);
  return (
    <SettingsSection title="Workflow profiles">
      <SettingsCard>
        <SettingsAction
          label={mutation.isSuccess ? "Profiles ready" : "Nine editable role profiles"}
          hint="Adds missing profiles only. Existing profiles and customizations stay unchanged. Edit provider, model, mode and effort in Agent profiles."
          actionLabel={mutation.isPending ? "Installing..." : "Install / repair profiles"}
          disabled={mutation.isPending}
          error={mutation.error?.message}
          onPress={installProfiles}
          testID="workflow-install-profiles"
        />
      </SettingsCard>
    </SettingsSection>
  );
}
