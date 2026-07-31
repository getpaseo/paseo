export function daemonPairingOfferQueryKey(serverId: string) {
  return ["daemon-pairing-offer", serverId] as const;
}
