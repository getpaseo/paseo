export interface CodeServerRecord {
  codeServerId: string;
  browserId: string;
  /** Workspace key used to scope default title numbering. Older records may omit this. */
  workspaceKey?: string | null;
  initialUrl: string;
  title: string;
  createdAt: number;
}

export interface CodeServerIndexState {
  codeServersById: Record<string, CodeServerRecord>;
}

export function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCodeServerUrl(value: string): string {
  const trimmed = trimNonEmpty(value);
  if (!trimmed) {
    return "http://127.0.0.1:8080";
  }
  if (/^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-fA-F:.]+])(?::\d+)?(?:[/?#]|$)/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return trimmed;
}

export function getNextCodeServerTitle(
  records: Record<string, CodeServerRecord>,
  workspaceKey?: string | null,
): string {
  const normalizedWorkspaceKey = trimNonEmpty(workspaceKey);
  let maxSuffix = 0;
  for (const record of Object.values(records)) {
    const recordWorkspaceKey = trimNonEmpty(record.workspaceKey);
    // Numbering is workspace-scoped. Records without a workspace key only
    // compete with other unscoped records (legacy / unknown workspace).
    if ((recordWorkspaceKey ?? null) !== (normalizedWorkspaceKey ?? null)) {
      continue;
    }
    const match = record.title.match(/^Code Server (\d+)$/);
    if (!match) {
      continue;
    }
    const suffix = Number(match[1]);
    if (Number.isInteger(suffix) && suffix > maxSuffix) {
      maxSuffix = suffix;
    }
  }
  return `Code Server ${maxSuffix + 1}`;
}

export function createCodeServerRecord(input: {
  codeServerId: string;
  browserId: string;
  workspaceKey?: string | null;
  initialUrl: string;
  title: string;
  now: number;
}): CodeServerRecord {
  return {
    codeServerId: input.codeServerId,
    browserId: input.browserId,
    workspaceKey: trimNonEmpty(input.workspaceKey),
    initialUrl: normalizeCodeServerUrl(input.initialUrl),
    title: trimNonEmpty(input.title) ?? "Code Server",
    createdAt: input.now,
  };
}

export function renameCodeServerInIndex<S extends CodeServerIndexState>(
  state: S,
  codeServerId: string,
  title: string,
): S {
  const normalizedCodeServerId = trimNonEmpty(codeServerId);
  const trimmedTitle = trimNonEmpty(title);
  if (!normalizedCodeServerId || !trimmedTitle) {
    return state;
  }
  const existing = state.codeServersById[normalizedCodeServerId];
  if (!existing || existing.title === trimmedTitle) {
    return state;
  }
  return {
    ...state,
    codeServersById: {
      ...state.codeServersById,
      [normalizedCodeServerId]: {
        ...existing,
        title: trimmedTitle,
      },
    },
  };
}

export function removeCodeServerFromIndex<S extends CodeServerIndexState>(
  state: S,
  codeServerId: string,
): S {
  const normalizedCodeServerId = trimNonEmpty(codeServerId);
  if (!normalizedCodeServerId || !state.codeServersById[normalizedCodeServerId]) {
    return state;
  }
  const next = { ...state.codeServersById };
  delete next[normalizedCodeServerId];
  return { ...state, codeServersById: next };
}
