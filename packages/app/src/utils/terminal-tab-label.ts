function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the terminal tab label, remembering the last live title/name so a
 * transient list-cache miss does not flash the generic "Terminal" fallback.
 */
export function resolveTerminalTabLabel(input: {
  title?: string | null;
  name?: string | null;
  rememberedLabel?: string | null;
  fallback: string;
}): { label: string; rememberedLabel: string | null } {
  const live = trimNonEmpty(input.title) ?? trimNonEmpty(input.name);
  if (live) {
    return { label: live, rememberedLabel: live };
  }

  const remembered = trimNonEmpty(input.rememberedLabel ?? null);
  if (remembered) {
    return { label: remembered, rememberedLabel: remembered };
  }

  return { label: input.fallback, rememberedLabel: null };
}
