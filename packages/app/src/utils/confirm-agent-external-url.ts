import { confirmDialog } from "@/utils/confirm-dialog";
import { openExternalUrl } from "@/utils/open-external-url";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export interface AgentExternalUrlDestination {
  host: string;
  hostname: string;
  url: string;
}

/**
 * The URL constructor canonicalizes internationalized hostnames to ASCII, so
 * the destination shown to the user cannot conceal a lookalike Unicode domain.
 */
export function parseAgentExternalUrl(url: string): AgentExternalUrlDestination | null {
  try {
    const destination = new URL(url);
    if (!ALLOWED_PROTOCOLS.has(destination.protocol) || !destination.hostname) {
      return null;
    }
    return { host: destination.host, hostname: destination.hostname, url: destination.href };
  } catch {
    return null;
  }
}

export function agentExternalUrlConfirmationMessage(
  destination: AgentExternalUrlDestination,
): string {
  const hostnameLabel = destination.hostname.includes("xn--")
    ? "Destination host (ASCII/punycode)"
    : "Destination host";
  return [
    `${hostnameLabel}: ${destination.host}`,
    `Full URL: ${destination.url}`,
    "",
    "This link was supplied by an agent. The live destination may differ from content inspected elsewhere.",
  ].join("\n");
}

/** Opens an agent-supplied external URL only after an explicit confirmation. */
export async function confirmAndOpenAgentExternalUrl(url: string): Promise<void> {
  const destination = parseAgentExternalUrl(url);
  if (!destination) {
    return;
  }

  const confirmed = await confirmDialog({
    title: "Open external link",
    message: agentExternalUrlConfirmationMessage(destination),
    confirmLabel: "Open live site",
    cancelLabel: "Cancel",
  });
  if (confirmed) {
    await openExternalUrl(destination.url);
  }
}
