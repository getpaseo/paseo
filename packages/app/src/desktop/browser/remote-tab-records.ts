export function duplicateRemoteBrowserRecordIds(
  records: readonly { browserId: string; remoteBrowserId: string | null }[],
): string[] {
  const owners = new Map<string, string[]>();
  for (const record of records) {
    if (!record.remoteBrowserId) continue;
    owners.set(record.remoteBrowserId, [
      ...(owners.get(record.remoteBrowserId) ?? []),
      record.browserId,
    ]);
  }
  const duplicates: string[] = [];
  for (const [remoteBrowserId, browserIds] of owners) {
    if (browserIds.length < 2) continue;
    const keep = browserIds.find((id) => id !== remoteBrowserId) ?? browserIds[0];
    duplicates.push(...browserIds.filter((id) => id !== keep));
  }
  return duplicates;
}
export function getBrowserPaneKind(input: {
  isElectron: boolean;
  supportsHostBrowser: boolean;
  remoteBrowserId: string | null;
}): "desktop" | "host" {
  return input.isElectron && !input.supportsHostBrowser && !input.remoteBrowserId
    ? "desktop"
    : "host";
}
