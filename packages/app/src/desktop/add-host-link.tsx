import { parseSshTransportUri } from "@getpaseo/protocol/ssh-transport";
import { useDesktopDeepLinkListener } from "@/desktop/deep-link-listener";
import type { DesktopHostBridge } from "@/desktop/host";
import { useAddSshHostFromLink } from "@/hosts/add-host";
import { useStableEvent } from "@/hooks/use-stable-event";

interface AddHostEventPayload {
  ssh?: unknown;
}

function addHostLinkReady(host: DesktopHostBridge) {
  return host.addHostLink?.ready;
}

function readSshTarget(payload: AddHostEventPayload | null): string | null {
  const ssh = typeof payload?.ssh === "string" ? payload.ssh.trim() : "";
  try {
    parseSshTransportUri(ssh);
  } catch {
    return null;
  }
  return ssh;
}

/** Opens the Remote SSH form, filled in, for a `paseo://hosts/add?ssh=...` link. */
export function AddHostLinkListener() {
  const addSshHost = useAddSshHostFromLink();
  const openAddHost = useStableEvent((payload: AddHostEventPayload | null) => {
    const sshTarget = readSshTarget(payload);
    if (sshTarget) {
      addSshHost(sshTarget);
    }
  });

  useDesktopDeepLinkListener<AddHostEventPayload>({
    event: "add-host",
    readyCall: addHostLinkReady,
    open: openAddHost,
  });

  return null;
}
