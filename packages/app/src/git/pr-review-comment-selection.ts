// Selection state for the PR review-comments list. Keyed by thread id so a poll
// refresh can preserve selections for threads that still exist and drop the rest.

export function toggleThreadSelection(
  selected: ReadonlySet<string>,
  threadId: string,
): Set<string> {
  const next = new Set(selected);
  if (next.has(threadId)) {
    next.delete(threadId);
  } else {
    next.add(threadId);
  }
  return next;
}

export function isFileFullySelected(
  selected: ReadonlySet<string>,
  fileThreadIds: readonly string[],
): boolean {
  return fileThreadIds.length > 0 && fileThreadIds.every((id) => selected.has(id));
}

// Toggle every thread in a file group: if all are already selected, clear them;
// otherwise add the missing ones.
export function toggleFileSelection(
  selected: ReadonlySet<string>,
  fileThreadIds: readonly string[],
): Set<string> {
  const next = new Set(selected);
  if (isFileFullySelected(selected, fileThreadIds)) {
    for (const id of fileThreadIds) {
      next.delete(id);
    }
  } else {
    for (const id of fileThreadIds) {
      next.add(id);
    }
  }
  return next;
}

// Keep only selections whose thread id is still present in the refreshed list.
export function pruneSelectionToExisting(
  selected: ReadonlySet<string>,
  existingThreadIds: readonly string[],
): Set<string> {
  const existing = new Set(existingThreadIds);
  const next = new Set<string>();
  for (const id of selected) {
    if (existing.has(id)) {
      next.add(id);
    }
  }
  return next;
}

export function selectionsAreEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const id of a) {
    if (!b.has(id)) {
      return false;
    }
  }
  return true;
}
