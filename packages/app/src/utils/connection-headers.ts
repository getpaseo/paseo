export interface ConnectionHeaderDraft {
  id: number;
  name: string;
  value: string;
}

export type ConnectionHeaderValidationIssue =
  | { type: "missingName" }
  | { type: "invalidName"; name: string }
  | { type: "invalidValue"; name: string }
  | { type: "duplicateName"; name: string };

const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function prepareConnectionHeaders(drafts: readonly ConnectionHeaderDraft[]): {
  headers?: Record<string, string>;
  issue?: ConnectionHeaderValidationIssue;
} {
  const headers: Record<string, string> = {};
  const normalizedNames = new Set<string>();

  for (const draft of drafts) {
    const name = draft.name.trim();
    const value = draft.value.trim();
    if (!name && !value) continue;
    if (!name) return { issue: { type: "missingName" } };
    if (!HTTP_HEADER_NAME_PATTERN.test(name)) {
      return { issue: { type: "invalidName", name } };
    }
    if (/\r|\n/.test(value)) {
      return { issue: { type: "invalidValue", name } };
    }

    const normalizedName = name.toLowerCase();
    if (normalizedNames.has(normalizedName)) {
      return { issue: { type: "duplicateName", name } };
    }
    normalizedNames.add(normalizedName);
    headers[name] = value;
  }

  return Object.keys(headers).length > 0 ? { headers } : {};
}

export function normalizeConnectionHeadersRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  const drafts: ConnectionHeaderDraft[] = [];
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") {
      return undefined;
    }
    drafts.push({ id: drafts.length, name, value: headerValue });
  }
  const result = prepareConnectionHeaders(drafts);
  return result.issue ? undefined : result.headers;
}
