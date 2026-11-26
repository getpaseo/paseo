import { parseSshTransportUri } from "./ssh-transport.js";

/**
 * Opens the Remote SSH form with the address filled in. Paseo adds the host only when the user
 * clicks Connect, so another app can offer the link without being able to add a host.
 */
export interface AddHostDeepLinkTarget {
  ssh: string;
}

const SSH_PARAM = "ssh";

function readSshUri(value: string): string | null {
  const uri = value.trim();
  try {
    parseSshTransportUri(uri);
  } catch {
    return null;
  }
  return uri;
}

export function buildAddHostDeepLink(target: AddHostDeepLinkTarget): string {
  const ssh = readSshUri(target.ssh);
  if (!ssh) {
    throw new Error("Add host links require a valid ssh:// address.");
  }
  return `paseo://hosts/add?${new URLSearchParams({ [SSH_PARAM]: ssh }).toString()}`;
}

export function parseAddHostDeepLink(input: string): AddHostDeepLinkTarget | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (
    url.protocol !== "paseo:" ||
    url.hostname !== "hosts" ||
    url.pathname !== "/add" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    return null;
  }

  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== SSH_PARAM) {
    return null;
  }
  const ssh = readSshUri(url.searchParams.get(SSH_PARAM) ?? "");
  return ssh ? { ssh } : null;
}
