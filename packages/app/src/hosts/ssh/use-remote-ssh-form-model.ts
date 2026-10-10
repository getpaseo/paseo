import { useEffect, useState } from "react";
import { openRemoteSshForm } from "./remote-ssh-form-model";
import type { HostMutations } from "@/runtime/host-runtime";
import { getSshKeyImportBridge, supportsSshKeyImport } from "./ssh-transport";
import { importPrivateKey } from "./import-private-key";

/** Construct once per open form and release secrets on unmount, including native dismissal. */
export function useRemoteSshFormModel(
  probeHost: HostMutations["probeAndUpsertRemoteSshConnection"],
) {
  const [model] = useState(() =>
    openRemoteSshForm({
      probeHost,
      keyImport: supportsSshKeyImport
        ? { bridge: getSshKeyImportBridge(), importPrivateKey }
        : null,
    }),
  );
  useEffect(() => () => model.close(), [model]);
  return model;
}
