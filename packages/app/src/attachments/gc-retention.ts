const retentionCounts = new Map<string, number>();

export function retainAttachmentForGarbageCollection(attachmentId: string): () => void {
  retentionCounts.set(attachmentId, (retentionCounts.get(attachmentId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const nextCount = (retentionCounts.get(attachmentId) ?? 1) - 1;
    if (nextCount <= 0) {
      retentionCounts.delete(attachmentId);
      return;
    }
    retentionCounts.set(attachmentId, nextCount);
  };
}

export function collectRetainedAttachmentIds(): ReadonlySet<string> {
  return new Set(retentionCounts.keys());
}
