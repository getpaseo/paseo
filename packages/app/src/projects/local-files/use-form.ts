import { useEffect, useState, useSyncExternalStore } from "react";
import { openLocalFilesForm, type LocalFilesTarget } from "./form";

export function useLocalFilesForm(target: LocalFilesTarget) {
  const [form] = useState(() => openLocalFilesForm(target));
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  useEffect(() => () => form.close(), [form]);
  return { form, state };
}
