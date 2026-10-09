import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import { parseRelayConnectionUri } from "@/utils/daemon-endpoints";

function pairingTarget(url: string): string | null {
  try {
    const trimmed = url.trim();
    const offer =
      trimmed.startsWith("relay://") || trimmed.includes("#connect=")
        ? parseRelayConnectionUri(trimmed).offer
        : parseConnectionOfferFromUrl(trimmed);
    return offer ? `${offer.serverId}:${offer.daemonPublicKeyB64}` : null;
  } catch {
    // Keep the last valid target while the user edits an incomplete URI.
    return null;
  }
}

/** Tracks the last valid host so harmless edits never clear its password. */
export class PairingTargetTracker {
  private currentTarget: string | null;

  constructor(initialUrl = "", startsFromDirectForm = false) {
    this.currentTarget = pairingTarget(initialUrl) ?? (startsFromDirectForm ? "direct-form" : null);
  }

  changeUrl(nextUrl: string): boolean {
    const nextTarget = pairingTarget(nextUrl);
    if (!nextTarget) return false;
    const changed = this.currentTarget !== null && this.currentTarget !== nextTarget;
    this.currentTarget = nextTarget;
    return changed;
  }
}
