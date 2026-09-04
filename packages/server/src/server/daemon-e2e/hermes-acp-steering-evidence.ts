export function createEvidenceRedactor(paths: string[], aliases: ReadonlyMap<string, string>) {
  const idAliases = new Map(aliases);
  const usedAliases = new Set(idAliases.values());
  const counts = new Map<string, number>();
  const opaqueIdKinds: Readonly<Record<string, string>> = {
    agentId: "agent",
    callId: "call",
    epoch: "epoch",
    nativeHandle: "session",
    projectId: "project",
    providerMessageId: "message",
    requestId: "request",
    serverId: "server",
    sessionId: "session",
    turnId: "turn",
    workspaceId: "workspace",
  };
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

  const redact = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") {
      const withoutPaths = paths
        .filter(Boolean)
        .reduce((text, candidate) => text.replaceAll(candidate, "<temp-path>"), value);
      const existing = idAliases.get(withoutPaths);
      if (existing) return existing;

      let kind = key ? opaqueIdKinds[key] : undefined;
      if (key === "messageId" && uuidPattern.test(withoutPaths)) {
        kind = "message";
      }
      if (!kind) return withoutPaths;

      let count = counts.get(kind) ?? 0;
      let alias: string;
      do {
        count += 1;
        alias = `<${kind}-${count}>`;
      } while (usedAliases.has(alias));
      counts.set(kind, count);
      usedAliases.add(alias);
      idAliases.set(withoutPaths, alias);
      return alias;
    }
    if (Array.isArray(value)) return value.map((entry) => redact(entry));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([entryKey, entry]) => [entryKey, redact(entry, entryKey)]),
      );
    }
    return value;
  };

  return redact;
}
