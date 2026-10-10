import { useHostMutations, useHosts } from "@/runtime/host-runtime";
import { RemoteSshHostForm, type AddRemoteSshHostModalProps } from "./remote-ssh-host-form";
export type { AddRemoteSshHostModalProps } from "./remote-ssh-host-form";

/** Bind SSH setup to the saved-host registry. */
export function AddRemoteSshHostModal(props: AddRemoteSshHostModalProps) {
  const hosts = useHosts();
  const { probeAndUpsertRemoteSshConnection } = useHostMutations();
  return (
    <RemoteSshHostForm
      {...props}
      hosts={hosts}
      probeAndUpsertRemoteSshConnection={probeAndUpsertRemoteSshConnection}
    />
  );
}
