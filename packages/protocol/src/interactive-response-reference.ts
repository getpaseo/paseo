export function extractInteractiveDocumentId(value: unknown, depth = 0): string | null {
  if (depth > 6 || !value) return null;
  if (typeof value === "string") {
    try {
      return extractInteractiveDocumentId(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const block of value) {
      const id = extractInteractiveDocumentId(block, depth + 1);
      if (id) return id;
    }
    return null;
  }
  if ("documentId" in value && typeof value.documentId === "string") return value.documentId;
  if ("structuredContent" in value) {
    const id = extractInteractiveDocumentId(value.structuredContent, depth + 1);
    if (id) return id;
  }
  if ("content" in value) {
    const id = extractInteractiveDocumentId(value.content, depth + 1);
    if (id) return id;
  }
  if ("text" in value) return extractInteractiveDocumentId(value.text, depth + 1);
  return null;
}
