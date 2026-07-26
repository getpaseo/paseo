import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SelectField, type SelectFieldDisplay } from "@/components/ui/select-field";
import {
  selectableContainerBackends,
  type AvailableBackendInfo,
} from "@/hooks/use-container-backend-availability";

export type ContainerBackend = string | null;

export interface ContainerBackendSelectorProps {
  value: ContainerBackend;
  /** Available backends from the availability response */
  backends: AvailableBackendInfo[];
  onChange: (value: ContainerBackend) => void;
}

export function ContainerBackendSelector({
  value,
  backends,
  onChange,
}: ContainerBackendSelectorProps) {
  const { t } = useTranslation();

  const selectableBackends = useMemo(() => selectableContainerBackends({ backends }), [backends]);

  const selectedDisplay: SelectFieldDisplay | null = useMemo(() => {
    if (value === null) {
      return { label: t("workspaceSetup.containerBackend.host") };
    }
    const backend = backends.find((b) => b.id === value);
    return { label: backend?.label ?? value };
  }, [value, backends, t]);

  // Host on its own is not a choice: with nothing to switch to, the field is
  // just a control that cannot change anything.
  if (selectableBackends.length === 0) {
    return null;
  }

  return (
    <SelectField<ContainerBackend>
      label={t("workspaceSetup.containerBackend.label")}
      value={value}
      selectedDisplay={selectedDisplay}
      onChange={onChange}
      placeholder={t("workspaceSetup.containerBackend.host")}
      emptyText={t("workspaceSetup.containerBackend.host")}
      options={[
        {
          id: "host",
          value: null,
          label: t("workspaceSetup.containerBackend.host"),
        },
        ...selectableBackends.map((backend) => ({
          id: backend.id,
          value: backend.id as ContainerBackend,
          label: backend.label,
          testID: `container-backend-${backend.id}`,
        })),
      ]}
      testID="container-backend-selector"
    />
  );
}
