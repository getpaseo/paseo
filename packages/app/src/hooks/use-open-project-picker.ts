import { useCallback } from "react";
import { useHostChooser } from "@/hosts/host-chooser";
import { useProjectPickerStore } from "@/stores/project-picker-store";

export function useOpenProjectPicker(): () => void {
  const chooseHost = useHostChooser();
  const openProjectPicker = useProjectPickerStore((state) => state.open);

  return useCallback(() => {
    chooseHost({
      title: "Choose host",
      onChooseHost: openProjectPicker,
    });
  }, [chooseHost, openProjectPicker]);
}
